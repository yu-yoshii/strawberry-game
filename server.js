const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// データベースのセットアップ
const db = new sqlite3.Database('./users.db', (err) => {
    if (err) console.error('DB接続エラー:', err.message);
    else console.log('データベースに接続しました。');
});

db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    rating INTEGER DEFAULT 1000
)`);

// ログイン・登録API
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.json({ success: false, message: 'ユーザー名とパスワードを入力してください。' });
    }
    db.run(`INSERT INTO users (username, password, rating) VALUES (?, ?, 1000)`, [username, password], function(err) {
        if (err) {
            return res.json({ success: false, message: 'そのユーザー名は既に使われています。' });
        }
        res.json({ success: true, user: { id: this.lastID, username, rating: 1000 } });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [username, password], (err, row) => {
        if (err || !row) {
            return res.json({ success: false, message: 'ユーザー名またはパスワードが間違っています。' });
        }
        res.json({ success: true, user: { id: row.id, username: row.username, rating: row.rating } });
    });
});

let waitingPlayer = null;
let rooms = {};

io.on('connection', (socket) => {
    console.log('接続:', socket.id);

    // マッチング待機列に並ぶ
    socket.on('startMatchmaking', (user) => {
        socket.user = user;

        if (waitingPlayer && waitingPlayer.id !== socket.id) {
            const roomId = 'room_' + Date.now();
            const p1 = waitingPlayer;
            const p2 = socket;

            waitingPlayer = null;

            p1.join(roomId);
            p2.join(roomId);

            const gameState = {
                roomId,
                players: [
                    { id: p1.id, username: p1.user.username, rating: p1.user.rating, score: 0, sets: 0 },
                    { id: p2.id, username: p2.user.username, rating: p2.user.rating, score: 0, sets: 0 }
                ],
                turnIndex: 0,
                deck: [],
                fieldCards: [],
                currentSet: 1,
                message: '3セットマッチ開始！場から「15」を作ろう。'
            };

            initGame(gameState);
            rooms[roomId] = gameState;
            io.to(roomId).emit('updateState', gameState);

        } else {
            waitingPlayer = socket;
            socket.emit('waiting', '対戦相手を待っています...');
        }
    });

    socket.on('cancelMatchmaking', () => {
        if (waitingPlayer === socket) {
            waitingPlayer = null;
        }
    });

    // 計算挑戦
    socket.on('tryCalc', ({ roomId, expression, selectedCards }) => {
        const room = rooms[roomId];
        if (!room) return;

        const currentPlayer = room.players[room.turnIndex];
        if (currentPlayer.id !== socket.id) return;

        try {
            if (!/^[0-9\+\-\*\/\(\)\.\s]+$/.test(expression)) {
                throw new Error();
            }
            const result = Function('"use strict";return (' + expression + ')')();

            if (Math.abs(result - 15) < 0.0001) {
                selectedCards.forEach(card => {
                    const idx = room.fieldCards.indexOf(card);
                    if (idx !== -1) room.fieldCards.splice(idx, 1);
                });

                currentPlayer.score += selectedCards.length;
                room.message = `${currentPlayer.username} が「15」を作った！ (+${selectedCards.length}枚)`;

                fillField(room);

                if (room.fieldCards.length === 0 || room.deck.length === 0) {
                    endSet(room);
                } else {
                    nextTurn(room);
                }
            } else {
                room.message = `計算結果が ${result} です（15ではありません）。`;
            }
        } catch (e) {
            room.message = '計算式が無効です。';
        }
        io.to(roomId).emit('updateState', room);
    });

    // パス
    socket.on('passTurn', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const currentPlayer = room.players[room.turnIndex];
        if (currentPlayer.id !== socket.id) return;

        room.message = `${currentPlayer.username} がパスしました。`;
        if (room.fieldCards.length > 0) room.fieldCards.shift();
        fillField(room);
        nextTurn();
        io.to(roomId).emit('updateState', room);
    });

    socket.on('disconnect', () => {
        if (waitingPlayer === socket) waitingPlayer = null;
    });
});

function initGame(room) {
    room.deck = [];
    for (let i = 1; i <= 31; i++) room.deck.push(i);
    for (let i = room.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]];
    }
    room.fieldCards = [];
    fillField(room);
}

function fillField(room) {
    while (room.fieldCards.length < 5 && room.deck.length > 0) {
        room.fieldCards.push(room.deck.pop());
    }
}

function nextTurn(room) {
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
}

function endSet(room) {
    let winner = room.players[0].score > room.players[1].score ? room.players[0] : 
                 room.players[1].score > room.players[0].score ? room.players[1] : null;

    if (winner) {
        winner.sets++;
        room.message = `【セット ${room.currentSet} 終了】勝者: ${winner.username}！`;
    } else {
        room.message = `【セット ${room.currentSet} 終了】引き分け！`;
    }

    if (room.currentSet >= 3 || room.players[0].sets >= 2 || room.players[1].sets >= 2) {
        let matchWinner = room.players[0].sets > room.players[1].sets ? room.players[0] : 
                          room.players[1].sets > room.players[0].sets ? room.players[1] : null;
        room.message += ` 🏆 試合終了！ 勝者: ${matchWinner ? matchWinner.username : '引き分け'}`;
    } else {
        room.currentSet++;
        room.players.forEach(p => p.score = 0);
        initGame(room);
    }
}

server.listen(3000, () => {
    console.log('サーバー起動: http://localhost:3000');
});