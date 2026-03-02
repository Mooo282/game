const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const allWords = ["نسر", "غراب", "بطارية", "سفاح", "ساطور", "نووي", "بلح", "زعتر", "شجرة", "مربع", "ستوديو", "عش", "حديد", "تكييف", "دماغ", "ضوضاء", "دخان", "قرص", "مايك", "حذاء", "طماطم", "سفنجة", "تصحيح", "سلاح", "اذاعة", "كيكة", "درع", "محتوى", "سوداوية", "عدمية", "هرجلة", "ايمان", "علاج", "تشفير", "كاسورة", "سيخ", "كديس", "كلب", "زريبة", "راية", "فيل", "مخرج", "احلام", "كهرباء", "الخلا", "ذهب", "اسفلت", "العالم", "السبيل", "نار", "مركب", "خازوق", "شبكة"];

let players = [], scores = {}, playerNames = {}, hostId = null;
let currentRound = 0, totalRounds = 0, correctWords = [], currentDrawerId = null;
let fakeWords = {}, votes = {}, guessesReceived = 0, timer, timeLeft = 60;
let gameState = "LOBBY", currentWords = [], currentClue = "", votingOptions = [];
let socketToUserId = {};
let drawerQueue = [];
let bannedUsers = new Set();

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

function emitPlayerList() {
    io.emit('updatePlayerList', {
        names: players.map(id => playerNames[id]),
        hostId: hostId
    });
}

function startTimer(duration, onTimeout) {
    clearInterval(timer);
    timeLeft = duration;
    io.emit('timerUpdate', timeLeft);
    timer = setInterval(() => {
        timeLeft--;
        io.emit('timerUpdate', timeLeft);
        if (timeLeft <= 0) { 
            clearInterval(timer); 
            if (onTimeout) onTimeout(); 
        }
    }, 1000);
}

io.on('connection', (socket) => {
    socket.on('joinGame', (data) => {
        const userId = data.userId;
        if (bannedUsers.has(userId)) return socket.emit('banned');
        socketToUserId[socket.id] = userId;
        if (!playerNames[userId]) {
            playerNames[userId] = data.name;
            scores[userId] = 0;
        }
        if (!players.includes(userId)) players.push(userId);
        if (!hostId || !players.includes(hostId)) hostId = players[0];
        socket.emit('setRole', { role: (userId === hostId ? 'host' : 'player'), name: playerNames[userId] });
        emitPlayerList();
    });

    socket.on('requestStart', (data) => {
        if (socketToUserId[socket.id] === hostId && gameState === "LOBBY") {
            players.forEach(id => scores[id] = 0);
            totalRounds = parseInt(data.rounds) || 5;
            currentRound = 1;
            startNewRound();
        }
    });

    function startNewRound() {
        gameState = "DRAWING"; guessesReceived = 0; fakeWords = {}; votes = {}; currentClue = "";
        if (drawerQueue.length === 0) drawerQueue = [...players].sort(() => 0.5 - Math.random());
        currentDrawerId = drawerQueue.shift();
        if (!players.includes(currentDrawerId) && players.length > 0) return startNewRound();

        currentWords = allWords.sort(() => 0.5 - Math.random()).slice(0, 12);
        io.emit('roundStarted', { 
            words: currentWords, 
            drawerId: currentDrawerId, 
            drawerName: playerNames[currentDrawerId],
            currentRound, totalRounds, scores, playerNames, hostId 
        });

        startTimer(60, () => {
            if (gameState === "DRAWING") startNewRound();
        });
    }

    socket.on('submitClue', (data) => {
        if (socketToUserId[socket.id] !== currentDrawerId || gameState !== "DRAWING") return;
        gameState = "FAKING"; correctWords = data.words; currentClue = data.clue;
        io.emit('showClue', { clue: currentClue, drawerName: playerNames[currentDrawerId], allWords: currentWords });
        startTimer(60, () => proceedToVoting());
    });

    socket.on('submitFake', (words) => {
        const uId = socketToUserId[socket.id];
        if (uId === currentDrawerId || fakeWords[uId] || gameState !== "FAKING") return;
        fakeWords[uId] = words;
        guessesReceived++;
        if (guessesReceived >= (players.length - 1)) proceedToVoting();
    });

    function proceedToVoting() {
        gameState = "VOTING"; clearInterval(timer); guessesReceived = 0;
        let options = [...correctWords];
        for (let id in fakeWords) options = options.concat(fakeWords[id]);
        votingOptions = [...new Set(options)].sort(() => 0.5 - Math.random());
        io.emit('startVoting', { options: votingOptions, drawerId: currentDrawerId });
        startTimer(45, () => finalizeRound());
    }

    socket.on('submitVote', (votedWords) => {
        const uId = socketToUserId[socket.id];
        if (uId === currentDrawerId || votes[uId] || gameState !== "VOTING") return;
        votes[uId] = votedWords;
        guessesReceived++;
        if (guessesReceived >= (players.length - 1)) finalizeRound();
    });

    function finalizeRound() {
        gameState = "RESULTS"; clearInterval(timer);
        calculateScores();
        io.emit('roundFinished', { correctWords, scores, names: playerNames });
        setTimeout(() => {
            if (currentRound < totalRounds) { currentRound++; startNewRound(); } 
            else { finishGame(); }
        }, 8000);
    }

    function calculateScores() {
        for (let voterId in votes) {
            const playerVote = votes[voterId];
            const isCorrect = playerVote.every(w => correctWords.includes(w)) && playerVote.length === correctWords.length;
            if (isCorrect) {
                scores[voterId] += 10;
                scores[currentDrawerId] += 5;
            } else {
                for (let fakerId in fakeWords) {
                    if (fakerId === voterId) continue;
                    if (playerVote.every(w => fakeWords[fakerId].includes(w))) scores[fakerId] += 7;
                }
            }
        }
    }

    function finishGame() {
        gameState = "LOBBY";
        const leaderboard = Object.keys(scores).map(id => ({ name: playerNames[id], score: scores[id] })).sort((a, b) => b.score - a.score);
        io.emit('gameOver', { leaderboard });
    }

    socket.on('disconnect', () => {
        const uId = socketToUserId[socket.id];
        players = players.filter(id => id !== uId);
        if (uId === currentDrawerId && gameState !== "LOBBY") startNewRound();
        emitPlayerList();
    });
});

server.listen(3000, () => console.log('Server started on port 3000'));
