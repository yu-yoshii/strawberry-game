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

const VERSION = "v1.2.0";

// データベースのセットアップ（データ永続化）
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

let waitingPlayer = null;
let rooms = {}; // roomId -> gameState

io.on('connection', (socket) => {
    console.log('接続:', socket.id);

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
                version: VERSION,
                players: [
                    { id: p1.id, username: p1.user.username, rating: p1.user.rating, score: 0, sets: 0 },
                    { id: p2.id, username: p2.user.username, rating: p2.user.rating, score: 0, sets: 0 }
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

    socket.on('cancelMatchmaking', () => {
        if (waitingPlayer === socket) waitingPlayer = null;
    });

    // 早押し解答の判定
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
                    socket.emit('notify', `場にないカード（または使いすぎたカード）が含まれています: ${num}`);
                    return;
                }
                currentField.splice(idx, 1);
            }

            const result = Function('"use strict";return (' + sanitized + ')')();

            if (Math.abs(result - 15) < 1e-9) {
                // 正解！
                player.score++;
                room.isReviewing = true;
                room.message = `🎉 ${player.username} が正解！ 「${expression} = 15」 (+1ポイント)`;
                io.to(roomId).emit('updateState', room);

                // 10秒間の答え合わせタイム
                setTimeout(() => {
                    if (!rooms[roomId]) return;

                    // セット勝利条件（ポイントが3に達したらセット獲得）
                    if (player.score >= 3) {
                        player.sets++;
                        room.players.forEach(p => p.score = 0); // ポイントリセット

                        // 試合終了条件（2セット先取、または第3セット終了）
                        if (room.currentSet >= 3 || room.players.some(p => p.sets >= 2)) {
                            room.isGameOver = true;
                            const matchWinner = room.players[0].sets > room.players[1].sets ? room.players[0] : 
                                                room.players[1].sets > room.players[0].sets ? room.players[1] : null;
                            room.message = `🏆 試合終了！ 勝者: ${matchWinner ? matchWinner.username : '引き分け'} (最終スコア ${room.players[0].sets} - ${room.players[1].sets})`;
                            io.to(roomId).emit('updateState', room);
                            return;
                        } else {
                            room.currentSet++;
                            room.message = `【セット ${room.currentSet} 開始】勝者: ${player.username}！次のセットへ`;
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

    // 切断時の処理（相手が切断したら残った方の勝ちにする）
    socket.on('disconnect', () => {
        if (waitingPlayer === socket) waitingPlayer = null;

        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1 && !room.isGameOver) {
                room.isGameOver = true;
                const opponent = room.players[1 - playerIndex];
                room.message = `⚠️ 対戦相手が切断しました。『${opponent.username}』の不戦勝です！`;
                io.to(roomId).emit('updateState', room);
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