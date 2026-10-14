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

const VERSION = "v1.8.0";

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

// 安全な数式評価パーサー
function evaluateExpression(expr) {
    let pos = 0;
    function parseNumber() {
        let start = pos;
        while (pos < expr.length && ((expr[pos] >= '0' && expr[pos] <= '9') || expr[pos] === '.')) {
            pos++;
        }
        if (start === pos) throw new Error('数値を期待しています');
        return parseFloat(expr.substring(start, pos));
    }

    function parseFactor() {
        skipWhitespace();
        if (expr[pos] === '(') {
            pos++;
            let val = parseExpression();
            skipWhitespace();
            if (expr[pos] !== ')') throw new Error('閉じ括弧が必要です');
            pos++;
            return val;
        } else if (expr[pos] === '-') {
            pos++;
            return -parseFactor();
        } else if (expr[pos] === '+') {
            pos++;
            return parseFactor();
        } else {
            return parseNumber();
        }
    }

    function parseTerm() {
        let val = parseFactor();
        while (true) {
            skipWhitespace();
            if (expr[pos] === '*') {
                pos++;
                val *= parseFactor();
            } else if (expr[pos] === '/') {
                pos++;
                let divisor = parseFactor();
                if (divisor === 0) throw new Error('ゼロ除算です');
                val /= divisor;
            } else {
                break;
            }
        }
        return val;
    }

    function parseExpression() {
        let val = parseTerm();
        while (true) {
            skipWhitespace();
            if (expr[pos] === '+') {
                pos++;
                val += parseTerm();
            } else if (expr[pos] === '-') {
                pos++;
                val -= parseTerm();
            } else {
                break;
            }
        }
        return val;
    }

    function skipWhitespace() {
        while (pos < expr.length && expr[pos] === ' ') {
            pos++;
        }
    }

    let val = parseExpression();
    skipWhitespace();
    if (pos < expr.length) throw new Error('無効な式です');
    return val;
}

function broadcastLobbyData() {
    db.all(`SELECT username, rating FROM users ORDER BY rating DESC LIMIT 10`, [], (err, rows) => {
        if (err) return;
        const ranking = rows || [];
        const waitingPlayers = waitingQueue.map(s => s.user.username);
        io.emit('lobbyData', { ranking, waitingPlayers });
    });
}

let waitingQueue = [];
let matchTimer = null;
let rooms = {};
let disconnectedPlayers = {}; // 再接続用管理マップ { userId: { roomId, socketId, timeout } }

io.on('connection', (socket) => {
    console.log('接続:', socket.id);

    socket.on('restoreSession', (userId, callback) => {
        db.get(`SELECT id, username, rating FROM users WHERE id = ?`, [userId], (err, row) => {
            if (err || !row) {
                callback({ success: false });
            } else {
                socket.user = row;
                
                // 再接続チェック
                if (disconnectedPlayers[row.id]) {
                    const info = disconnectedPlayers[row.id];
                    clearTimeout(info.timeout);
                    delete disconnectedPlayers[row.id];

                    const room = rooms[info.roomId];
                    if (room && !room.isGameOver) {
                        const player = room.players.find(p => p.dbId === row.id);
                        if (player) {
                            player.id = socket.id;
                            socket.join(info.roomId);
                            socket.currentGameRoom = info.roomId;
                            callback({ success: true, user: row, reconnectRoom: room });
                            io.to(info.roomId).emit('updateState', room);
                            return;
                        }
                    }
                }

                callback({ success: true, user: row });
            }
        });
    });

    socket.on('requestLobbyData', () => {
        broadcastLobbyData();
    });

    // ソロ練習モード開始
    socket.on('startSoloMode', (userId) => {
        db.get(`SELECT id, username, rating FROM users WHERE id = ?`, [userId], (err, row) => {
            if (err || !row) return;
            socket.user = row;

            const roomId = 'solo_' + Date.now();
            const gameState = {
                roomId,
                version: VERSION,
                isSolo: true,
                players: [
                    { id: socket.id, dbId: row.id, username: row.username, rating: row.rating, score: 0, passRequested: false }
                ],
                deck: [],
                fieldCards: [],
                currentRound: 1,
                isReviewing: false,
                isGameOver: false,
                message: '🍓 ソロ練習モード 🍓 5枚すべて使って「15」を作ろう！（制限なし）'
            };

            initGame(gameState);
            rooms[roomId] = gameState;
            socket.join(roomId);
            socket.currentGameRoom = roomId;
            socket.emit('updateState', gameState);
        });
    });

    socket.on('startMatchmaking', (userId) => {
        db.get(`SELECT id, username, rating FROM users WHERE id = ?`, [userId], (err, row) => {
            if (err || !row) return;
            socket.user = row;

            if (!waitingQueue.some(s => s.id === socket.id)) {
                waitingQueue.push(socket);
                socket.emit('waiting', '対戦相手を待っています (2〜4人)...');
                broadcastLobbyData();
                checkAndStartMatch();
            }
        });
    });

    socket.on('cancelMatchmaking', () => {
        waitingQueue = waitingQueue.filter(s => s.id !== socket.id);
        if (waitingQueue.length < 2 && matchTimer) {
            clearTimeout(matchTimer);
            matchTimer = null;
        }
        broadcastLobbyData();
    });

    socket.on('requestPass', ({ roomId, pass }) => {
        const room = rooms[roomId];
        if (!room || room.isReviewing || room.isGameOver) return;

        if (room.isSolo) {
            initGame(room);
            room.message = 'カードを新しく更新しました！';
            io.to(roomId).emit('updateState', room);
            return;
        }

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        player.passRequested = pass;
        const passCount = room.players.filter(p => p.passRequested).length;
        const requiredPass = Math.floor(room.players.length / 2) + 1;

        if (passCount >= requiredPass) {
            room.players.forEach(p => p.passRequested = false);
            room.message = '過半数がパスを選択しました。新しいカードに更新します！';
            initGame(room);
        } else {
            room.message = `${player.username} がパスを希望しています (${passCount}/${requiredPass})`;
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
            if (usedNumbers.length !== room.fieldCards.length) {
                socket.emit('notify', `カードをちょうど${room.fieldCards.length}枚すべて使ってください！（現在 ${usedNumbers.length}枚）`);
                return;
            }

            const currentField = [...room.fieldCards];
            for (let num of usedNumbers) {
                const idx = currentField.indexOf(num);
                if (idx === -1) {
                    socket.emit('notify', `場にないカード、または使いすぎのカードが含まれています: ${num}`);
                    return;
                }
                currentField.splice(idx, 1);
            }

            const result = evaluateExpression(sanitized);

            if (Math.abs(result - 15) < 1e-9) {
                player.score++;
                room.isReviewing = true;
                room.players.forEach(p => p.passRequested = false);
                room.message = `🎉 ${player.username} が正解！ 「${expression} = 15」`;
                io.to(roomId).emit('updateState', room);

                setTimeout(() => {
                    if (!rooms[roomId]) return;

                    if (room.isSolo) {
                        room.message = `🌟 正解おめでとう！次の問題へ...`;
                        room.isReviewing = false;
                        initGame(room);
                        io.to(roomId).emit('updateState', room);
                        return;
                    }

                    if (player.score >= 3) {
                        room.isGameOver = true;
                        const sortedPlayers = [...room.players].sort((a, b) => b.score - a.score);
                        
                        let processedCount = 0;
                        sortedPlayers.forEach((p, index) => {
                            let change = index === 0 ? 24 : (index === 1 && room.players.length === 2 ? -12 : (index === 1 ? 4 : -12));

                            db.get(`SELECT rating FROM users WHERE id = ?`, [p.dbId], (err, row) => {
                                if (!err && row) {
                                    let newRating = Math.max(100, row.rating + change);
                                    db.run(`UPDATE users SET rating = ? WHERE id = ?`, [newRating, p.dbId], () => {
                                        p.rating = newRating;
                                        processedCount++;
                                        if (processedCount === sortedPlayers.length) {
                                            room.message = `🏆 試合終了！ 勝者: ${sortedPlayers[0].username} 🎉`;
                                            io.to(roomId).emit('updateState', room);
                                            broadcastLobbyData();
                                        }
                                    });
                                }
                            });
                        });
                        return;
                    } else {
                        room.currentRound++;
                        room.message = `ラウンド勝利: ${player.username}！次の問題へ...`;
                    }

                    room.isReviewing = false;
                    initGame(room);
                    io.to(roomId).emit('updateState', room);
                }, 4000);

            } else {
                socket.emit('notify', `計算結果が ${result} です（15ではありません）。`);
            }
        } catch (e) {
            socket.emit('notify', '計算式が無効です。括弧や演算子を確認してください。');
        }
    });

    socket.on('disconnect', () => {
        waitingQueue = waitingQueue.filter(s => s.id !== socket.id);
        if (waitingQueue.length < 2 && matchTimer) {
            clearTimeout(matchTimer);
            matchTimer = null;
        }
        broadcastLobbyData();

        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1 && !room.isGameOver) {
                const disconnectedPlayer = room.players[playerIndex];

                if (room.isSolo) {
                    setTimeout(() => { delete rooms[roomId]; }, 5000);
                    break;
                }

                // 20秒間再接続を待つ
                disconnectedPlayers[disconnectedPlayer.dbId] = {
                    roomId,
                    socketId: socket.id,
                    timeout: setTimeout(() => {
                        if (rooms[roomId] && !rooms[roomId].isGameOver) {
                            rooms[roomId].isGameOver = true;
                            rooms[roomId].message = `⚠️ 対戦相手 (${disconnectedPlayer.username}) が切断しました。タイムアウトで試合終了。`;
                            io.to(roomId).emit('updateState', rooms[roomId]);
                            setTimeout(() => { delete rooms[roomId]; }, 5000);
                        }
                        delete disconnectedPlayers[disconnectedPlayer.dbId];
                    }, 20000)
                };

                room.message = `⚠️ ${disconnectedPlayer.username} が切断しました（20秒以内に再接続で復帰可能）`;
                io.to(roomId).emit('updateState', room);
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