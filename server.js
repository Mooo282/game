const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const allWords = ["نسر", "غراب", "بطارية", "سفاح", "ساطور", "نووي", "بلح", "زعتر", "شجرة", "مربع", "ستوديو", "عش", "حديد", "تكييف", "دماغ", "ضوضاء", "دخان", "قرص", "مايك", "حذاء", "طماطم", "سفنجة", "تصحيح", "سلاح", "اذاعة", "كيكة", "درع", "محتوى", "سوداوية", "عدمية", "هرجلة", "ايمان", "علاج", "تشفير", "كاسورة", "سيخ", "كديس", "كلب", "زريبة", "راية", "فيل", "مخرج", "احلام", "كهرباء", "الخلا", "ذهب", "اسفلت", "العالم", "السبيل", "نار", "مركب", "خازوق", "شبكة", "مسدس", "عربية", "خفاش", "سفينة", "شتاء", "صيف", "مشوار", "قمر", "ضل", "اخضر", "صينية", "وسط", "زميل", "كباية", "حلة", "فارغ", "عالي", "مسامح", "وعي", "ضباب", "ادبي", "مثقف", "علمي", "رطوبة"];

let players = [], scores = {}, playerNames = {}, hostId = null;
let currentRound = 0, totalRounds = 999, targetScore = 9999, gameMode = "ROUNDS"; 
let correctWords = [], currentDrawerId = null, fakeWords = {}, votes = {}, guessesReceived = 0, timer, timeLeft = 60;
let gameState = "LOBBY", currentWords = [], currentClue = "";
let socketToUserId = {}, drawerQueue = [], disconnectTimeouts = {}, onlinePlayers = new Set();

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

function emitPlayerList() {
    io.emit('updatePlayerList', { players, playerNames, hostId, scores, gameState, onlinePlayers: Array.from(onlinePlayers) });
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
        const uId = data.userId;
        socketToUserId[socket.id] = uId;
        if (disconnectTimeouts[uId]) {
            clearTimeout(disconnectTimeouts[uId]);
            delete disconnectTimeouts[uId];
            io.emit('newChat', { sender: "النظام 🤖", text: `عاد ${data.name} للاتصال ⚡`, color: "#10b981" });
        }
        playerNames[uId] = data.name;
        onlinePlayers.add(uId);
        if (!players.includes(uId)) { players.push(uId); scores[uId] = scores[uId] || 0; }
        if (!hostId || !players.includes(hostId)) hostId = uId;
        emitPlayerList();
        if (gameState !== "LOBBY") socket.emit('restoreState', { gameState, currentDrawerId, currentClue, currentWords, currentRound, totalRounds, targetScore, gameMode });
    });

    socket.on('requestStart', (data) => {
        if (socketToUserId[socket.id] === hostId && gameState === "LOBBY") {
            players.forEach(id => scores[id] = 0);
            gameMode = data.mode;
            if (gameMode === "ROUNDS") {
                totalRounds = parseInt(data.rounds);
                targetScore = 9999;
            } else {
                targetScore = parseInt(data.points);
                totalRounds = 999;
            }
            currentRound = 1;
            drawerQueue = [];
            startNewRound();
        }
    });

    function startNewRound() {
        gameState = "DRAWING"; guessesReceived = 0; fakeWords = {}; votes = {}; currentClue = "";
        if (drawerQueue.length === 0) drawerQueue = [...players].sort(() => 0.5 - Math.random());
        currentDrawerId = drawerQueue.shift();
        
        let isChaos = (gameMode === "ROUNDS" && currentRound === totalRounds) || 
                      (gameMode === "POINTS" && players.some(id => scores[id] >= targetScore * 0.8));

        currentWords = allWords.sort(() => 0.5 - Math.random()).slice(0, 15);
        io.emit('roundStarted', { words: currentWords, drawerId: currentDrawerId, drawerName: playerNames[currentDrawerId], currentRound, totalRounds, gameMode, targetScore, isChaos });
        startTimer(60, () => { if(gameState === "DRAWING") startNewRound(); });
    }

    socket.on('submitClue', (data) => {
        if (socketToUserId[socket.id] !== currentDrawerId || !data.clue) return;
        gameState = "FAKING"; correctWords = data.words.sort(); currentClue = data.clue;
        players.forEach(pId => {
            if (pId !== currentDrawerId) {
                const pWords = allWords.filter(w => !correctWords.includes(w)).sort(() => 0.5 - Math.random()).slice(0, 15);
                const pSocketId = Object.keys(socketToUserId).find(k => socketToUserId[k] === pId);
                if (pSocketId) io.to(pSocketId).emit('showClue', { clue: currentClue, pWords, drawerName: playerNames[currentDrawerId] });
            }
        });
        startTimer(60, () => proceedToVoting());
    });

    socket.on('submitFake', (words) => {
        const uId = socketToUserId[socket.id];
        if (uId === currentDrawerId || fakeWords[uId] || gameState !== "FAKING") return;
        fakeWords[uId] = words.sort();
        guessesReceived++;
        if (guessesReceived >= (players.length - 1)) proceedToVoting();
    });

    function proceedToVoting() {
        gameState = "VOTING"; guessesReceived = 0;
        let options = [correctWords, ...Object.values(fakeWords)];
        let uniqueOptions = Array.from(new Set(options.map(JSON.stringify)), JSON.parse).sort(() => 0.5 - Math.random());
        io.emit('startVoting', { options: uniqueOptions, drawerId: currentDrawerId });
        startTimer(60, () => finalizeRound());
    }

    socket.on('submitVote', (votedPair) => {
        const uId = socketToUserId[socket.id];
        if (uId === currentDrawerId || votes[uId] || gameState !== "VOTING") return;
        votes[uId] = votedPair.sort();
        guessesReceived++;
        if (guessesReceived >= (players.length - 1)) finalizeRound();
    });

    function finalizeRound() {
        gameState = "RESULTS";
        calculateScores();
        emitPlayerList();
        
        let voteDetails = {};
        for (let vId in votes) {
            const voteStr = votes[vId].join(" + ");
            if (!voteDetails[voteStr]) voteDetails[voteStr] = [];
            voteDetails[voteStr].push(playerNames[vId]);
        }

        io.emit('roundFinished', { correctWords, scores, voteDetails });

        setTimeout(() => {
            const anyoneWon = players.some(id => scores[id] >= targetScore);
            const roundsOver = (gameMode === "ROUNDS" && currentRound >= totalRounds);

            if (anyoneWon || roundsOver) {
                finishGame();
            } else {
                currentRound++;
                startNewRound();
            }
        }, 8000);
    }

    function calculateScores() {
        let isChaos = (gameMode === "ROUNDS" && currentRound === totalRounds) || 
                      (gameMode === "POINTS" && players.some(id => scores[id] >= targetScore * 0.8));
        const multiplier = isChaos ? 2 : 1;

        for (let voterId in votes) {
            const vote = votes[voterId];
            if (JSON.stringify(vote) === JSON.stringify(correctWords)) {
                scores[voterId] += (10 * multiplier); scores[currentDrawerId] += (5 * multiplier);
            } else {
                for (let fId in fakeWords) {
                    if (fId !== voterId && JSON.stringify(vote) === JSON.stringify(fakeWords[fId])) scores[fId] += (7 * multiplier);
                }
            }
        }
    }

    function finishGame() {
        gameState = "LOBBY";
        const leaderboard = players.map(id => ({ name: playerNames[id], score: scores[id] })).sort((a,b) => b.score - a.score);
        io.emit('gameOver', { leaderboard });
    }

    socket.on('sendChat', (msg) => {
        const uId = socketToUserId[socket.id];
        if (msg) io.emit('newChat', { sender: playerNames[uId], text: msg, color: uId === currentDrawerId ? "#f59e0b" : "#6366f1" });
    });

    socket.on('disconnect', () => {
        const uId = socketToUserId[socket.id];
        if (uId) {
            onlinePlayers.delete(uId);
            emitPlayerList();
            disconnectTimeouts[uId] = setTimeout(() => {
                if (!onlinePlayers.has(uId)) {
                    players = players.filter(id => id !== uId);
                    if (uId === currentDrawerId) startNewRound();
                    if (uId === hostId) hostId = players[0] || null;
                    emitPlayerList();
                }
            }, 30000);
            delete socketToUserId[socket.id];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

