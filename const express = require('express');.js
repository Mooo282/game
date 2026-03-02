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
let gameState = "LOBBY", currentWords = [], currentClue = "";
let socketToUserId = {};
let drawerQueue = [];
let disconnectTimeouts = {}; 

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

function emitPlayerList() {
    io.emit('updatePlayerList', { players, playerNames, hostId });
}

function startTimer(duration, onTimeout) {
    clearInterval(timer);
    timeLeft = duration;
    io.emit('timerUpdate', timeLeft);
    timer = setInterval(() => {
        timeLeft--;
        io.emit('timerUpdate', timeLeft);
        if (timeLeft <= 0) { clearInterval(timer); if (onTimeout) onTimeout(); }
    }, 1000);
}

io.on('connection', (socket) => {
    socket.on('joinGame', (data) => {
        const userId = data.userId;
        if (disconnectTimeouts[userId]) {
            clearTimeout(disconnectTimeouts[userId]);
            delete disconnectTimeouts[userId];
        }
        socketToUserId[socket.id] = userId;
        if (data.name) playerNames[userId] = data.name;
        if (scores[userId] === undefined) scores[userId] = 0;
        if (!players.includes(userId)) players.push(userId);
        if (!hostId || !players.includes(hostId)) hostId = players[0];
        emitPlayerList();
    });

    socket.on('requestStart', (data) => {
        if (socketToUserId[socket.id] === hostId && gameState === "LOBBY") {
            players.forEach(id => scores[id] = 0);
            totalRounds = parseInt(data.rounds) || 5;
            currentRound = 1;
            drawerQueue = [];
            startNewRound();
        }
    });

    function startNewRound() {
        gameState = "DRAWING"; guessesReceived = 0; fakeWords = {}; votes = {}; currentClue = "";
        if (drawerQueue.length === 0) drawerQueue = [...players].sort(() => 0.5 - Math.random());
        currentDrawerId = drawerQueue.shift();
        if (!players.includes(currentDrawerId)) {
            if (players.length > 0) return startNewRound();
            return finishGame();
        }
        currentWords = allWords.sort(() => 0.5 - Math.random()).slice(0, 12);
        io.emit('roundStarted', { words: currentWords, drawerId: currentDrawerId, drawerName: playerNames[currentDrawerId], currentRound, totalRounds });
        startTimer(60, () => { if (gameState === "DRAWING") startNewRound(); });
    }

    socket.on('submitClue', (data) => {
        if (socketToUserId[socket.id] !== currentDrawerId || gameState !== "DRAWING") return;
        gameState = "FAKING"; correctWords = data.words; currentClue = data.clue;
        io.emit('showClue', { clue: currentClue, allWords: currentWords, drawerId: currentDrawerId });
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
        let votingOptions = [...new Set(options)].sort(() => 0.5 - Math.random());
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
        io.emit('roundFinished', { correctWords, scores, playerNames });
        setTimeout(() => {
            if (currentRound < totalRounds && players.length > 0) { currentRound++; startNewRound(); } 
            else { finishGame(); }
        }, 5000);
    }

    function calculateScores() {
        for (let voterId in votes) {
            const vote = votes[voterId];
            if (JSON.stringify(vote.sort()) === JSON.stringify(correctWords.sort())) {
                scores[voterId] += 10; scores[currentDrawerId] += 5;
            } else {
                for (let fId in fakeWords) {
                    if (fId !== voterId && JSON.stringify(vote.sort()) === JSON.stringify(fakeWords[fId].sort())) {
                        scores[fId] += 7;
                    }
                }
            }
        }
    }

    function finishGame() {
        gameState = "LOBBY";
        const leaderboard = players.map(id => ({ name: playerNames[id], score: scores[id] })).sort((a,b) => b.score - a.score);
        io.emit('gameOver', { leaderboard });
    }

    socket.on('disconnect', () => {
        const uId = socketToUserId[socket.id];
        if (uId) {
            disconnectTimeouts[uId] = setTimeout(() => {
                players = players.filter(id => id !== uId);
                delete playerNames[uId];
                delete scores[uId];
                if (uId === hostId) hostId = players.length > 0 ? players[0] : null;
                emitPlayerList();
                delete disconnectTimeouts[uId];
            }, 60000);
            delete socketToUserId[socket.id];
        }
    });
});

server.listen(3000, () => console.log('Server is online: http://localhost:3000'));
