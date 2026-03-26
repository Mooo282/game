const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const allWords = ["نسر", "غراب", "بطارية", "سفاح", "ساطور", "نووي", "بلح", "زعتر", "شجرة", "مربع", "ستوديو", "عش", "حديد", "تكييف", "دماغ", "ضوضاء", "دخان", "قرص", "مايك", "حذاء", "طماطم", "سفنجة", "تصحيح", "سلاح", "اذاعة", "كيكة", "درع", "محتوى", "سوداوية", "عدمية", "هرجلة", "ايمان", "علاج", "تشفير", "سيخ", "فيل", "مخرج", "احلام", "كهرباء", "ذهب", "اسفلت", "العالم", "نار", "مركب", "شبكة", "مسدس", "عربية", "خفاش", "سفينة", "شتاء", "صيف", "قمر", "ضل", "اخضر", "صينية", "كباية", "حلة", "وعي", "ضباب"];

let rooms = {};

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

function emitPlayerList(roomId) {
    const room = rooms[roomId];
    if(room) {
        io.to(roomId).emit('updatePlayerList', { 
            players: room.players, 
            playerNames: room.playerNames, 
            hostId: room.hostId, 
            scores: room.scores, // إرسال النقاط بشكل صريح
            onlinePlayers: Array.from(room.onlinePlayers) 
        });
    }
}

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
                currentRound: 0, totalRounds: 5, targetScore: 100, gameMode: "ROUNDS",
                currentWords: [], currentClue: "", fakeWords: {}, votes: {}, correctWords: [],
                currentDrawerId: null, guessesReceived: 0
            };
        }

        const room = rooms[roomId];
        room.playerNames[userId] = name;
        room.onlinePlayers.add(userId);
        if (!room.players.includes(userId)) { 
            room.players.push(userId); 
            room.scores[userId] = 0; 
        }
        
        emitPlayerList(roomId);

        if (room.gameState !== "LOBBY") {
            socket.emit('roundStarted', { 
                words: room.currentWords, drawerId: room.currentDrawerId, 
                drawerName: room.playerNames[room.currentDrawerId],
                currentRound: room.currentRound, totalRounds: room.totalRounds,
                gameMode: room.gameMode, targetScore: room.targetScore
            });
        }
    });

    socket.on('requestStart', (data) => {
        const room = rooms[socket.roomId];
        if (room && socket.userId === room.hostId) {
            room.gameMode = data.mode;
            room.totalRounds = parseInt(data.rounds);
            room.targetScore = parseInt(data.points);
            room.currentRound = 1;
            room.players.forEach(id => room.scores[id] = 0);
            startNewRound(socket.roomId);
        }
    });

    function startNewRound(roomId) {
        const room = rooms[roomId];
        if(!room) return;
        room.gameState = "DRAWING"; room.guessesReceived = 0; room.fakeWords = {}; room.votes = {};
        if (room.drawerQueue.length === 0) room.drawerQueue = [...room.players].sort(() => 0.5 - Math.random());
        room.currentDrawerId = room.drawerQueue.shift();
        room.currentWords = allWords.sort(() => 0.5 - Math.random()).slice(0, 15);
        
        io.to(roomId).emit('roundStarted', { 
            words: room.currentWords, drawerId: room.currentDrawerId, 
            drawerName: room.playerNames[room.currentDrawerId],
            currentRound: room.currentRound, totalRounds: room.totalRounds,
            gameMode: room.gameMode, targetScore: room.targetScore
        });
        emitPlayerList(roomId); // تحديث القائمة لتظهر النقاط الجديدة
    }

    socket.on('submitClue', (data) => {
        const room = rooms[socket.roomId];
        if (!room || socket.userId !== room.currentDrawerId) return;
        room.gameState = "FAKING"; room.correctWords = data.words.sort(); room.currentClue = data.clue;
        io.to(socket.roomId).emit('showClue', { clue: room.currentClue, drawerName: room.playerNames[room.currentDrawerId], state: "FAKING" });
    });

    socket.on('submitFake', (words) => {
        const room = rooms[socket.roomId];
        if (!room) return;
        room.fakeWords[socket.userId] = words.sort();
        room.guessesReceived++;
        if (room.guessesReceived >= (room.players.length - 1)) {
            room.gameState = "VOTING"; room.guessesReceived = 0;
            const options = Array.from(new Set([room.correctWords, ...Object.values(room.fakeWords)].map(JSON.stringify)), JSON.parse).sort(() => 0.5 - Math.random());
            io.to(socket.roomId).emit('startVoting', { options, drawerId: room.currentDrawerId });
        }
    });

    socket.on('submitVote', (votedPair) => {
        const room = rooms[socket.roomId];
        if (!room) return;
        room.votes[socket.userId] = votedPair.sort();
        room.guessesReceived++;
        if (room.guessesReceived >= (room.players.length - 1)) finalizeRound(socket.roomId);
    });

    function finalizeRound(roomId) {
        const room = rooms[roomId];
        if(!room) return;
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
        
        emitPlayerList(roomId); // إرسال النقاط الجديدة فوراً بعد الحساب
        io.to(roomId).emit('roundFinished', { correctWords: room.correctWords, scores: room.scores });
        
        setTimeout(() => { 
            const anyoneWon = room.gameMode === "POINTS" && room.players.some(id => room.scores[id] >= room.targetScore);
            const roundsOver = room.gameMode === "ROUNDS" && room.currentRound >= room.totalRounds;
            if (anyoneWon || roundsOver) { io.to(roomId).emit('gameOver', { scores: room.scores }); room.gameState = "LOBBY"; }
            else { room.currentRound++; startNewRound(roomId); }
        }, 6000);
    }

    socket.on('disconnect', () => {
        const rId = socket.roomId;
        const uId = socket.userId;
        if(rooms[rId]) {
            rooms[rId].onlinePlayers.delete(uId);
            emitPlayerList(rId);
            
            // حذف الغرفة إذا لم يتبق أي لاعب أونلاين
            if (rooms[rId].onlinePlayers.size === 0) {
                console.log(`حذف الغرفة الفارغة: ${rId}`);
                delete rooms[rId];
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
