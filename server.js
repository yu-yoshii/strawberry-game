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

const VERSION = "v1.4.1";

const dbPath = path.resolve(__dirname, 'users.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('DB接続エラー:', err.message);
    else console.log('データベース接続完了:', dbPath);
});

db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    rating INTEGER DEFAULT 1000
)`);

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, message: '入力してください。' });
    db.run(`INSERT INTO users (username, password, rating) VALUES (?, ?, 1000)`, [username, password], function(err) {
        if (err) return res.json({ success: false, message: 'そのユーザー名は既に使われています。' });
        res.json({ success: true, user: { id: this.lastID, username, rating: 1000 } });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [username, password], (err, row) => {
        if (err || !row) return res.json({ success: false, message: 'ユーザー名またはパスワードが違います。' });
        res.json({ success: true, user: { id: row.id, username: row.username, rating: row.rating } });
    });
});

function updateRating(userId, isWinner, callback) {
    db.get(`SELECT rating FROM users WHERE id = ?`, [userId], (err, row) => {
        if (err || !row) return;
        let currentRating = row.rating;
        const change = isWinner ? 24 : -12;
        let newRating = Math.max(100, currentRating + change);

        db.run(`UPDATE users SET rating = ? WHERE id = ?`, [newRating, userId], () => {
            if (callback) callback(newRating);
        });
    });
}

let waitingPlayer = null;
let rooms = {};

io.on('connection', (socket) => {
    console.log('接続:', socket.id);

    socket.on('restoreSession', (userId, callback) => {
        db.get(`SELECT id, username, rating FROM users WHERE id = ?`, [userId], (err, row) => {
            if (err || !row) {
                callback({ success: false });
            } else {
                socket.user = row;
                callback({ success: true, user: row });
            }
        });
    });

    socket.on('startMatchmaking', (userId) => {
        db.get(`SELECT id, username, rating FROM users WHERE id = ?`, [userId], (err, row) => {
            if (err || !row) return;
            socket.user = row;

            if (waitingPlayer && waitingPlayer.id !== socket.id) {
                const roomId = 'room_' + Date.now();
                const p1 = waitingPlayer;
                const p2 = socket;
                waitingPlayer = null;

                p1.join(roomId);
                p2.join(roomId);

                    const gameState = {
                    roomId,
                    version: VERSION,
                    players: [
                        { id: p1.id, dbId: p1.user.id, username: p1.user.username, rating: p1.user.rating, score: 0, sets: 0, passRequested: false },
                        { id: p2.id, dbId: p2.user.id, username: p2.user.username, rating: p2.user.rating, score: 0, sets: 0, passRequested: false }
                    ],
                    deck: [],
                    fieldCards: [],
                    currentSet: 1,
                    isReviewing: false,
                    isGameOver: false,
                    message: '3セットマッチ開始！ 5枚すべて使って「15」を作れ！'
                };

                initGame(gameState);
                rooms[roomId] = gameState;
                io.to(roomId).emit('updateState', gameState);
            } else {
                waitingPlayer = socket;
                socket.emit('waiting', '対戦相手を待っています...');
            }
        });
    });

    socket.on('cancelMatchmaking', () => {
        if (waitingPlayer === socket) waitingPlayer = null;
    });

    socket.on('requestPass', ({ roomId, pass }) => {
        const room = rooms[roomId];
        if (!room || room.isReviewing || room.isGameOver) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        player.passRequested = pass;

        const bothPassed = room.players.every(p => p.passRequested);
        if (bothPassed) {
            room.players.forEach(p => p.passRequested = false);
            room.message = '両者がパスを選択しました。新しいカードに更新します！';
            initGame(room);
        } else {
            room.message = `${player.username} がパスを希望しています`;
        }

        io.to(roomId).emit('updateState', room);
    });

    socket.on('tryCalc', ({ roomId, expression }) => {
        const room = rooms[roomId];
        if (!room || room.isReviewing || room.isGameOver) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        try {
            const sanitized = expression.replace(/×/g, '*').replace(/÷/g, '/');
            if (!/^[0-9\+\-\*\/\(\)\.\s]+$/.test(sanitized)) {
                throw new Error('無効な文字');
            }

            const usedNumbers = sanitized.match(/\d+/g)?.map(Number) || [];
            const currentField = [...room.fieldCards];

            if (usedNumbers.length !== currentField.length) {
                socket.emit('notify', `カードをちょうど5枚すべて使ってください！（現在 ${usedNumbers.length}枚）`);
                return;
            }

            for (let num of usedNumbers) {
                const idx = currentField.indexOf(num);
                if (idx === -1) {
                    socket.emit('notify', `場にないカードが含まれています: ${num}`);
                    return;
                }
                currentField.splice(idx, 1);
            }

            const result = Function('"use strict";return (' + sanitized + ')')();

            if (Math.abs(result - 15) < 1e-9) {
                player.score++;
                room.isReviewing = true;
                room.players.forEach(p => p.passRequested = false);
                room.message = `🎉 ${player.username} が正解！ 「${expression} = 15」`;
                io.to(roomId).emit('updateState', room);

                setTimeout(() => {
                    if (!rooms[roomId]) return;

                    // ラウンド（またはセット内ポイント）が3点に達したとき
                    if (player.score >= 3) {
                        player.sets++; // セット獲得
                        room.players.forEach(p => p.score = 0); // ラウンドスコアリセット

                        // どちらかが 2セット先取 した場合、または 3セット目が終わった場合
                        if (player.sets >= 2 || room.currentSet >= 3) {
                            room.isGameOver = true;
                            // 勝者の決定（setsが多い方）
                            const winner = room.players[0].sets > room.players[1].sets ? room.players[0] : room.players[1];
                            const loser = room.players.find(p => p.id !== winner.id);

                            updateRating(winner.dbId, true, (newR) => {
                                winner.rating = newR;
                                updateRating(loser.dbId, false, (newR2) => {
                                    loser.rating = newR2;
                                    room.message = `🏆 試合終了！ 勝者: ${winner.username} 🎉`;
                                    io.to(roomId).emit('updateState', room);
                                });
                            });
                            return;
                        } else {
                            // 次のセットへ移行
                            room.currentSet++;
                            room.message = `【セット ${room.currentSet} 開始】前セット勝者: ${player.username}！`;
                        }
                    } else {
                        room.message = `ラウンド勝利: ${player.username}！次の問題へ...`;
                    }

                    room.isReviewing = false;
                    initGame(room);
                    io.to(roomId).emit('updateState', room);
                }, 10000);

            } else {
                socket.emit('notify', `計算結果が ${result} です（15ではありません）。`);
            }
        } catch (e) {
            socket.emit('notify', '計算式が無効です。括弧や演算子を確認してください。');
        }
    });

    socket.on('disconnect', () => {
        if (waitingPlayer === socket) waitingPlayer = null;

        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1 && !room.isGameOver) {
                room.isGameOver = true;
                const winner = room.players[1 - playerIndex];
                const loser = room.players[playerIndex];

                updateRating(winner.dbId, true, (newR) => {
                    winner.rating = newR;
                    updateRating(loser.dbId, false, (newR2) => {
                        loser.rating = newR2;
                        room.message = `⚠️ 対戦相手が切断しました。『${winner.username}』の不戦勝です！`;
                        io.to(roomId).emit('updateState', room);
                    });
                });

                setTimeout(() => {
                    delete rooms[roomId];
                }, 5000);
            }
        }
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
    while (room.fieldCards.length < 5 && room.deck.length > 0) {
        room.fieldCards.push(room.deck.pop());
    }
}

server.listen(3000, () => {
    console.log(`サーバー起動 (${VERSION}): http://localhost:3000`);
});