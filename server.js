const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const allWords = ["نسر", "غراب", "بطارية", "سفاح", "ساطور", "نووي", "بلح", "زعتر", "شجرة", "مربع", "ستوديو", "عش", "حديد", "تكييف", "دماغ", "ضوضاء", "دخان", "قرص", "مايك", "حذاء", "طماطم", "سفنجة", "تصحيح", "سلاح", "اذاعة", "كيكة", "درع", "محتوى", "سوداوية", "عدمية", "هرجلة", "ايمان", "علاج", "تشفير", "سيخ", "فيل", "مخرج", "احلام", "كهرباء", "ذهب", "اسفلت", "العالم", "نار", "مركب", "شبكة", "مسدس", "عربية", "خفاش", "سفينة", "شتاء", "صيف", "قمر", "ضل", "اخضر", "صينية", "كباية", "حلة", "وعي", "ضباب"];

let rooms = {};

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

io.on('connection', (socket) => {
    socket.on('joinGame', (data) => {
        const { userId, name, roomId } = data;
        socket.userId = userId;
        socket.roomId = roomId;
        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [], scores: {}, playerNames: {}, hostId: userId,
                gameState: "LOBBY", onlinePlayers: new Set(), drawerQueue: [],
                currentRound: 0, totalRounds: 5, currentWords: [], currentClue: "", 
                fakeWords: {}, votes: {}, correctWords: [], guessesReceived: 0, currentDrawerId: null
            };
        }

        const room = rooms[roomId];
        room.playerNames[userId] = name;
        room.onlinePlayers.add(userId);
        if (!room.players.includes(userId)) { room.players.push(userId); room.scores[userId] = 0; }
        if (!room.hostId || !room.players.includes(room.hostId)) room.hostId = userId;

        emitPlayerList(roomId);

        // استعادة الحالة عند الريفرش (الجزء المهم)
        if (room.gameState !== "LOBBY") {
            socket.emit('roundStarted', { 
                words: room.currentWords, drawerId: room.currentDrawerId, 
                drawerName: room.playerNames[room.currentDrawerId],
                currentRound: room.currentRound, totalRounds: room.totalRounds
            });
            
            if (room.gameState === "FAKING" || room.gameState === "VOTING") {
                const pWords = allWords.filter(w => !room.correctWords.includes(w)).sort(() => 0.5 - Math.random()).slice(0, 15);
                socket.emit('showClue', { clue: room.currentClue, pWords, drawerName: room.playerNames[room.currentDrawerId], state: room.gameState });
            }
        }
    });

    socket.on('requestStart', (data) => {
        const room = rooms[socket.roomId];
        if (room && socket.userId === room.hostId) {
            room.totalRounds = parseInt(data.rounds) || 5;
            room.currentRound = 1;
            startNewRound(socket.roomId);
        }
    });

    function startNewRound(roomId) {
        const room = rooms[roomId];
        room.gameState = "DRAWING"; room.guessesReceived = 0; room.fakeWords = {}; room.votes = {};
        if (room.drawerQueue.length === 0) room.drawerQueue = [...room.players].sort(() => 0.5 - Math.random());
        room.currentDrawerId = room.drawerQueue.shift();
        room.currentWords = allWords.sort(() => 0.5 - Math.random()).slice(0, 15);
        io.to(roomId).emit('roundStarted', { 
            words: room.currentWords, drawerId: room.currentDrawerId, 
            drawerName: room.playerNames[room.currentDrawerId],
            currentRound: room.currentRound, totalRounds: room.totalRounds
        });
    }

    socket.on('submitClue', (data) => {
        const room = rooms[socket.roomId];
        if (!room || socket.userId !== room.currentDrawerId) return;
        room.gameState = "FAKING"; room.correctWords = data.words.sort(); room.currentClue = data.clue;
        
        // إرسال الكلمات العشوائية لكل لاعب ليختار منها التضليل
        room.players.forEach(pId => {
            if (pId !== room.currentDrawerId) {
                const pWords = allWords.filter(w => !room.correctWords.includes(w)).sort(() => 0.5 - Math.random()).slice(0, 15);
                const pSocket = Array.from(io.sockets.sockets.values()).find(s => s.userId === pId && s.roomId === socket.roomId);
                if(pSocket) pSocket.emit('showClue', { clue: room.currentClue, pWords, drawerName: room.playerNames[room.currentDrawerId], state: "FAKING" });
            }
        });
    });

    socket.on('submitFake', (words) => {
        const room = rooms[socket.roomId];
        if (!room || room.gameState !== "FAKING") return;
        room.fakeWords[socket.userId] = words.sort();
        room.guessesReceived++;
        if (room.guessesReceived >= (room.players.length - 1)) {
            room.gameState = "VOTING"; room.guessesReceived = 0;
            const options = [room.correctWords, ...Object.values(room.fakeWords)].sort(() => 0.5 - Math.random());
            io.to(socket.roomId).emit('startVoting', { options, drawerId: room.currentDrawerId });
        }
    });

    socket.on('submitVote', (votedPair) => {
        const room = rooms[socket.roomId];
        if (!room || room.gameState !== "VOTING") return;
        room.votes[socket.userId] = votedPair.sort();
        room.guessesReceived++;
        if (room.guessesReceived >= (room.players.length - 1)) finalizeRound(socket.roomId);
    });

    function finalizeRound(roomId) {
        const room = rooms[roomId];
        room.players.forEach(vId => {
            if (vId === room.currentDrawerId) return;
            const vote = JSON.stringify(room.votes[vId]);
            if (vote === JSON.stringify(room.correctWords)) {
                room.scores[vId] += 10; room.scores[room.currentDrawerId] += 5;
            } else {
                for (let fId in room.fakeWords) {
                    if (fId !== vId && vote === JSON.stringify(room.fakeWords[fId])) room.scores[fId] += 7;
                }
            }
        });
        io.to(roomId).emit('roundFinished', { correctWords: room.correctWords, scores: room.scores });
        setTimeout(() => { 
            if(room.currentRound < room.totalRounds) { room.currentRound++; startNewRound(roomId); }
            else { io.to(roomId).emit('gameOver', { scores: room.scores }); room.gameState = "LOBBY"; }
        }, 8000);
    }

    function emitPlayerList(roomId) {
        const room = rooms[roomId];
        if(room) io.to(roomId).emit('updatePlayerList', { players: room.players, playerNames: room.playerNames, hostId: room.hostId, scores: room.scores, onlinePlayers: Array.from(room.onlinePlayers) });
    }

    socket.on('disconnect', () => {
        if(rooms[socket.roomId]) { rooms[socket.roomId].onlinePlayers.delete(socket.userId); emitPlayerList(socket.roomId); }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
