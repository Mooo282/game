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

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

function startTimer(duration, callback) {
    clearInterval(timer);
    timeLeft = duration;
    io.emit('timerUpdate', timeLeft);
    timer = setInterval(() => {
        timeLeft--;
        io.emit('timerUpdate', timeLeft);
        if (timeLeft <= 0) { clearInterval(timer); callback(); }
    }, 1000);
}

io.on('connection', (socket) => {
    players.push(socket.id);
    scores[socket.id] = 0;

    socket.on('joinGame', (name) => {
        playerNames[socket.id] = name || "لاعب مجهول";
        if (!hostId) hostId = socket.id;
        socket.emit('setRole', { role: (socket.id === hostId ? 'host' : 'player'), name: playerNames[socket.id] });
        
        if (gameState !== "LOBBY") {
            socket.emit('syncGame', {
                state: gameState,
                words: (gameState === "VOTING" ? votingOptions : currentWords),
                drawerId: currentDrawerId,
                drawerName: playerNames[currentDrawerId],
                clue: currentClue,
                round: currentRound,
                total: totalRounds,
                scores, playerNames, timeLeft
            });
        }
    });

    socket.on('requestStart', (data) => {
        if (socket.id === hostId && gameState === "LOBBY") {
            totalRounds = parseInt(data.rounds) || 5;
            currentRound = 1;
            startNewRound();
        }
    });

    function startNewRound() {
        gameState = "DRAWING"; guessesReceived = 0; fakeWords = {}; votes = {}; currentClue = "";
        currentDrawerId = players[Math.floor(Math.random() * players.length)];
        currentWords = allWords.sort(() => 0.5 - Math.random()).slice(0, 12);
        io.emit('roundStarted', { words: currentWords, drawerId: currentDrawerId, drawerName: playerNames[currentDrawerId], currentRound, totalRounds, scores, playerNames });
        startTimer(60, () => {}); 
    }

    socket.on('submitClue', (data) => {
        gameState = "FAKING";
        correctWords = data.words;
        currentClue = data.clue;
        guessesReceived = 0;
        io.emit('showClue', { clue: currentClue, drawerId: currentDrawerId, drawerName: playerNames[currentDrawerId] });
        startTimer(60, () => proceedToVoting());
    });

    socket.on('submitFake', (words) => {
        if (socket.id === currentDrawerId) return;
        fakeWords[socket.id] = words;
        guessesReceived++;
        socket.emit('waiting');
        if (guessesReceived >= (players.length - 1)) proceedToVoting();
    });

    function proceedToVoting() {
        gameState = "VOTING";
        clearInterval(timer);
        guessesReceived = 0;
        let options = [...correctWords];
        for (let id in fakeWords) { options = options.concat(fakeWords[id]); }
        votingOptions = [...new Set(options)].sort(() => 0.5 - Math.random());
        io.emit('startVoting', { options: votingOptions });
        startTimer(45, () => finalizeRound());
    }

    socket.on('submitVote', (votedWords) => {
        votes[socket.id] = votedWords;
        guessesReceived++;
        socket.emit('waiting');
        if (guessesReceived >= (players.length - 1)) finalizeRound();
    });

    function finalizeRound() {
        gameState = "RESULTS";
        clearInterval(timer);
        calculateScores();
        io.emit('roundFinished', { correctWords, scores, names: playerNames });
        setTimeout(() => {
            if (currentRound < totalRounds) { currentRound++; startNewRound(); }
            else { gameState = "LOBBY"; io.emit('gameOver', { scores, names: playerNames }); }
        }, 8000); // 8 ثوانٍ لمشاهدة النتائج
    }

    function calculateScores() {
        for (let vId in votes) {
            if (vId === currentDrawerId) continue;
            const isCorrect = votes[vId] && votes[vId].every(w => correctWords.includes(w));
            if (isCorrect) { scores[vId] += 10; scores[currentDrawerId] += 5; }
            else {
                for (let fId in fakeWords) {
                    if (votes[vId] && votes[vId].every(w => fakeWords[fId].includes(w))) { scores[fId] += 7; }
                }
            }
        }
    }

    socket.on('disconnect', () => {
        players = players.filter(id => id !== socket.id);
        if (socket.id === hostId) hostId = (players.length > 0) ? players[0] : null;
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));
