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
    socket.on('joinGame', (data) => {
        const userId = data.userId;
        const name = data.name;
        socketToUserId[socket.id] = userId;

        if (!playerNames[userId]) {
            playerNames[userId] = name;
            scores[userId] = 0;
            if (!players.includes(userId)) players.push(userId);
        }

        if (!hostId || !players.includes(hostId)) hostId = userId;
        
        socket.emit('setRole', { 
            role: (userId === hostId ? 'host' : 'player'), 
            name: playerNames[userId],
            userId: userId
        });

        // إرسال قائمة اللاعبين المتصلين للجميع
        const onlineNames = players.map(id => playerNames[id]);
        io.emit('updatePlayerList', onlineNames);

        if (gameState !== "LOBBY") {
            socket.emit('syncGame', {
                state: gameState, words: (gameState === "VOTING" ? votingOptions : currentWords),
                drawerId: currentDrawerId, drawerName: playerNames[currentDrawerId],
                clue: currentClue, round: currentRound, total: totalRounds,
                scores, playerNames, timeLeft
            });
        }
    });

    socket.on('requestStart', (data) => {
        if (socketToUserId[socket.id] === hostId) {
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
        if (socketToUserId[socket.id] !== currentDrawerId) return;
        gameState = "FAKING"; correctWords = data.words; currentClue = data.clue; guessesReceived = 0;
        io.emit('showClue', { clue: currentClue, drawerId: currentDrawerId, drawerName: playerNames[currentDrawerId] });
        startTimer(60, () => proceedToVoting());
    });

    socket.on('submitFake', (words) => {
        const uId = socketToUserId[socket.id];
        if (uId === currentDrawerId || fakeWords[uId]) return;
        fakeWords[uId] = words;
        guessesReceived++;
        socket.emit('waiting');
        if (guessesReceived >= (players.length - 1)) proceedToVoting();
    });

    function proceedToVoting() {
        gameState = "VOTING"; clearInterval(timer); guessesReceived = 0;
        let options = [...correctWords];
        for (let id in fakeWords) options = options.concat(fakeWords[id]);
        votingOptions = [...new Set(options)].sort(() => 0.5 - Math.random());
        io.emit('startVoting', { options: votingOptions });
        startTimer(45, () => finalizeRound());
    }

    socket.on('submitVote', (votedWords) => {
        const uId = socketToUserId[socket.id];
        if (uId === currentDrawerId || votes[uId]) return;
        votes[uId] = votedWords;
        guessesReceived++;
        socket.emit('waiting');
        if (guessesReceived >= (players.length - 1)) finalizeRound();
    });

    function finalizeRound() {
        gameState = "RESULTS"; clearInterval(timer);
        calculateScores();
        io.emit('roundFinished', { correctWords, scores, names: playerNames });
        setTimeout(() => {
            if (currentRound < totalRounds) { currentRound++; startNewRound(); }
            else { gameState = "LOBBY"; io.emit('gameOver', { scores, names: playerNames }); }
        }, 8000);
    }

    function calculateScores() {
        for (let vId in votes) {
            if (vId === currentDrawerId) continue;
            if (votes[vId].every(w => correctWords.includes(w))) {
                scores[vId] += 10; scores[currentDrawerId] += 5;
            } else {
                for (let fId in fakeWords) {
                    if (votes[vId].every(w => fakeWords[fId].includes(w))) scores[fId] += 7;
                }
            }
        }
    }

    socket.on('disconnect', () => {
        delete socketToUserId[socket.id];
        // لا نحذف البيانات من القوائم للسماح بالعودة عبر sessionStorage
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));
