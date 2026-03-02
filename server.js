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
        if (gameState !== "LOBBY") {
            socket.emit('syncGame', {
                state: gameState, drawerId: currentDrawerId, drawerName: playerNames[currentDrawerId],
                clue: currentClue, round: currentRound, total: totalRounds, scores, playerNames,
                words: (userId === currentDrawerId ? currentWords : (gameState === "FAKING" ? currentWords : [])), votingOptions
            });
        }
    });

    socket.on('kickPlayer', (targetName) => {
        if (socketToUserId[socket.id] === hostId) {
            const targetUserId = players.find(id => playerNames[id] === targetName);
            if (targetUserId) {
                bannedUsers.add(targetUserId);
                const targetSid = Object.keys(socketToUserId).find(sid => socketToUserId[sid] === targetUserId);
                if (targetSid) {
                    io.to(targetSid).emit('kicked');
                    io.sockets.sockets.get(targetSid)?.disconnect();
                }
            }
        }
    });

    socket.on('requestStart', (data) => {
        if (socketToUserId[socket.id] === hostId && gameState === "LOBBY") {
            players.forEach(id => scores[id] = 0);
            drawerQueue = [];
            totalRounds = parseInt(data.rounds) || 5;
            currentRound = 1;
            startNewRound();
        }
    });

    function startNewRound() {
        gameState = "DRAWING"; guessesReceived = 0; fakeWords = {}; votes = {}; currentClue = "";
        
        if (drawerQueue.length === 0) {
            drawerQueue = [...players].sort(() => 0.5 - Math.random());
        }
        currentDrawerId = drawerQueue.shift();

        
        if (!players.includes(currentDrawerId) && players.length > 0) return startNewRound();

        currentWords = allWords.sort(() => 0.5 - Math.random()).slice(0, 12);
        players.forEach(pId => {
            const sid = Object.keys(socketToUserId).find(k => socketToUserId[k] === pId);
            if (sid) io.to(sid).emit('roundStarted', { 
                words: (pId === currentDrawerId ? currentWords : []), 
                drawerId: currentDrawerId, drawerName: playerNames[currentDrawerId],
                currentRound, totalRounds, scores, playerNames, hostId 
            });
        });

        
        startTimer(60, () => {
            if (gameState === "DRAWING") {
                io.emit('statusUpdate', `انتهى وقت ${playerNames[currentDrawerId]}! يتم تبديل المشفّر...`);
                setTimeout(() => startNewRound(), 2000); 
            }
        });
    }

    socket.on('submitClue', (data) => {
        if (socketToUserId[socket.id] !== currentDrawerId || gameState !== "DRAWING") return;
        gameState = "FAKING"; correctWords = data.words; currentClue = data.clue;
        io.emit('showClue', { clue: currentClue, drawerName: playerNames[currentDrawerId], allWords: currentWords, hostId });
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
        io.emit('startVoting', { options: votingOptions, drawerId: currentDrawerId, hostId });
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
        io.emit('roundFinished', { correctWords, scores, names: playerNames, allVotes: votes, finalOptions: votingOptions, hostId });
        setTimeout(() => {
            if (currentRound < totalRounds && players.length > 0) { 
                currentRound++; 
                startNewRound(); 
            } else { 
                finishGame(); 
            }
        }, 10000); 
    }

    function calculateScores() {
        for (let vId in votes) {
            if (votes[vId].every(w => correctWords.includes(w))) {
                scores[vId] += 10; scores[currentDrawerId] += 5;
            } else {
                for (let fId in fakeWords) {
                    if (votes[vId].every(w => fakeWords[fId].includes(w))) scores[fId] += 7;
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
        delete socketToUserId[socket.id];
        if (uId === hostId && players.length > 0) hostId = players[0];
        emitPlayerList();
    });
});

server.listen(3000, () => console.log('Server started'));

