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

const VERSION = "v1.1.0";

// データベースのセットアップ（永続化のためプロジェクトディレクトリ直下に確実保存）
const dbPath = path.resolve(__dirname, 'users.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('DB接続エラー:', err.message);
    else console.log('データベースに接続しました:', dbPath);
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
let rooms = {};

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
        if (!room || room.isReviewing) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        try {
            const sanitized = expression.replace(/×/g, '*').replace(/÷/g, '/');
            if (!/^[0-9\+\-\*\/\(\)\.\s]+$/.test(sanitized)) {
                throw new Error('無効な文字');
            }

            // 1. 式に含まれる数字を抽出
            const usedNumbers = sanitized.match(/\d+/g)?.map(Number) || [];
            
            // 2. 場にある5枚のカードのコピー
            const currentField = [...room.fieldCards];

            // 3. 5枚すべて使っているか、かつ場のカードと完全に一致するかチェック
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

            // 4. 計算結果が15か検証
            const result = Function('"use strict";return (' + sanitized + ')')();

            if (Math.abs(result - 15) < 1e-9) {
                // 正解！
                player.score++;
                room.isReviewing = true;
                room.message = `🎉 ${player.username} が正解！ 「${expression} = 15」`;
                io.to(roomId).emit('updateState', room);

                // 10秒間の答え合わせタイム
                setTimeout(() => {
                    if (!rooms[roomId]) return;
                    // セット終了条件（セットで3問先取、またはカード切れなど）
                    if (player.score >= 3) {
                        player.sets++;
                        room.message = `🏆 セット ${room.currentSet} 勝利者: ${player.username}`;
                        if (room.currentSet >= 3 || room.players.some(p => p.sets >= 2)) {
                            room.message += ` — 試合終了！`;
                            io.to(roomId).emit('updateState', room);
                            return;
                        } else {
                            room.currentSet++;
                            room.players.forEach(p => p.score = 0);
                        }
                    }
                    room.isReviewing = false;
                    initGame(room);
                    room.message = `次の問題！ 5枚すべて使って「15」を作れ！`;
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