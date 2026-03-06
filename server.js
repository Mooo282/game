const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const allWords = [
    "نسر", "غراب", "بطارية", "سفاح", "ساطور", "نووي", "بلح", "زعتر", "شجرة", "مربع", 
    "ستوديو", "عش", "حديد", "تكييف", "دماغ", "ضوضاء", "دخان", "قرص", "مايك", "حذاء", 
    "طماطم", "سفنجة", "تصحيح", "سلاح", "اذاعة", "كيكة", "درع", "محتوى", "سوداوية", 
    "عدمية", "هرجلة", "ايمان", "علاج", "تشفير", "كاسورة", "سيخ", "كديس", "كلب", 
    "زريبة", "راية", "فيل", "مخرج", "احلام", "كهرباء", "الخلا", "ذهب", "اسفلت", 
    "العالم", "السبيل", "نار", "مركب", "خازوق", "شبكة", "مسدس", "عربية", "خفاش", 
    "سفينة", "شتاء", "صيف", "مشوار", "قمر", "ضل", "اخضر", "صينية", "وسط", "زميل", 
    "كباية", "حلة", "فارغ", "عالي", "مسامح", "وعي", "ضباب", "ادبي", "مثقف", "علمي", "رطوبة"
];

let players = [], scores = {}, playerNames = {}, hostId = null;
let currentRound = 0, totalRounds = 0, correctWords = [], currentDrawerId = null;
let fakeWords = {}, votes = {}, guessesReceived = 0, timer, timeLeft = 60;
let gameState = "LOBBY", currentWords = [], currentClue = "";
let socketToUserId = {};
let drawerQueue = [];
let disconnectTimeouts = {}; 

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

function emitPlayerList() {
    io.emit('updatePlayerList', { players, playerNames, hostId, scores, gameState });
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
        const uId = data.userId;
        if (disconnectTimeouts[uId]) { clearTimeout(disconnectTimeouts[uId]); delete disconnectTimeouts[uId]; }
        socketToUserId[socket.id] = uId;
        playerNames[uId] = data.name;
        if (scores[uId] === undefined) scores[uId] = 0;
        if (!players.includes(uId)) players.push(uId);
        if (!hostId || !players.includes(hostId)) hostId = uId;
        emitPlayerList();
    });

    socket.on('requestStart', (data) => {
        if (socketToUserId[socket.id] === hostId && gameState === "LOBBY") {
            players.forEach(id => scores[id] = 0); 
            totalRounds = parseInt(data.rounds) || 5;
            currentRound = 1; drawerQueue = [];
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
        startTimer(60, () => { if(gameState === "DRAWING") startNewRound(); });
    }

    socket.on('submitClue', (data) => {
        if (socketToUserId[socket.id] !== currentDrawerId || !data.clue || !data.clue.trim()) return;
        gameState = "FAKING"; 
        correctWords = data.words.sort(); 
        currentClue = data.clue;
        
        players.forEach(pId => {
            if (pId !== currentDrawerId) {
                // فلترة الكلمات الصحيحة من قائمة المضللين
                const filteredWords = allWords.filter(w => !correctWords.includes(w));
                const playerWords = filteredWords.sort(() => 0.5 - Math.random()).slice(0, 12);
                const pSocketId = Object.keys(socketToUserId).find(k => socketToUserId[k] === pId);
                if (pSocketId) io.to(pSocketId).emit('showClue', { clue: currentClue, pWords: playerWords, drawerName: playerNames[currentDrawerId] });
            }
        });
        startTimer(60, () => proceedToVoting());
    });

    socket.on('submitFake', (words) => {
        const uId = socketToUserId[socket.id];
        const sortedWords = words.sort();
        if (uId === currentDrawerId || fakeWords[uId] || gameState !== "FAKING") return;
        
        // منع التضليل المتطابق مع الكلمات الصحيحة
        if (JSON.stringify(sortedWords) === JSON.stringify(correctWords)) return;

        fakeWords[uId] = sortedWords;
        guessesReceived++;
        if (guessesReceived >= (players.length - 1)) proceedToVoting();
    });

    function proceedToVoting() {
        gameState = "VOTING"; guessesReceived = 0;
        let options = [];
        options.push(correctWords);
        for (let id in fakeWords) options.push(fakeWords[id]);
        
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
        gameState = "RESULTS"; calculateScores(); emitPlayerList();
        let voteDetails = {};
        for (let vId in votes) {
            const voteStr = votes[vId].join(" + ");
            if (!voteDetails[voteStr]) voteDetails[voteStr] = [];
            voteDetails[voteStr].push(playerNames[vId]);
        }
        io.emit('roundFinished', { correctWords, scores, voteDetails });
        setTimeout(() => {
            if (currentRound < totalRounds && players.length > 0) { currentRound++; startNewRound(); } 
            else { finishGame(); }
        }, 8000); 
    }

    function calculateScores() {
        for (let voterId in votes) {
            const vote = votes[voterId];
            if (JSON.stringify(vote) === JSON.stringify(correctWords)) {
                scores[voterId] += 10; scores[currentDrawerId] += 5;
            } else {
                for (let fId in fakeWords) {
                    if (fId !== voterId && JSON.stringify(vote) === JSON.stringify(fakeWords[fId])) scores[fId] += 7;
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
                // معالجة خروج المشفر
                if (uId === currentDrawerId && (gameState === "DRAWING" || gameState === "FAKING" || gameState === "VOTING")) {
                    startNewRound();
                }
                if (uId === hostId) hostId = players.length > 0 ? players[0] : null;
                delete playerNames[uId]; delete scores[uId];
                emitPlayerList();
            }, 10000);
            delete socketToUserId[socket.id];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server Online on port ${PORT}`));
