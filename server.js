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

const VERSION = "v1.8.2";

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

let rooms = {};

function getLobbyInfo() {
    return new Promise((resolve) => {
        db.all(`SELECT username, rating FROM users ORDER BY rating DESC LIMIT 10`, [], (err, rows) => {
            const ranking = rows || [];
            const roomList = Object.keys(rooms).map(roomId => ({
                roomId,
                host: rooms[roomId].hostName,
                playerCount: rooms[roomId].players.length,
                status: rooms[roomId].isGameStarted ? '対戦中' : '募集中'
            }));
            resolve({ ranking, roomList });
        });
    });
}

async function broadcastLobbyData() {
    const data = await getLobbyInfo();
    io.emit('lobbyData', data);
}

// 順位に応じた基本レート変動量を返す関数
function getBaseRatingChange(rankIndex, totalPlayers) {
    if (totalPlayers === 2) {
        return rankIndex === 0 ? 24 : -12;
    }
    // 3人以上の場合のベース変動
    if (rankIndex === 0) return 24;
    if (rankIndex === 1) return 4;
    if (rankIndex === 2) return -8;
    return -16; // 4位以降
}

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

    socket.on('requestLobbyData', async () => {
        const data = await getLobbyInfo();
        socket.emit('lobbyData', data);
    });

    socket.on('createRoom', ({ userId }) => {
        db.get(`SELECT id, username, rating FROM users WHERE id = ?`, [userId], (err, row) => {
            if (err || !row) return;
            socket.user = row;

            const roomId = 'room_' + Date.now();
            rooms[roomId] = {
                roomId,
                version: VERSION,
                hostId: socket.id,
                hostName: row.username,
                isGameStarted: false,
                players: [{
                    id: socket.id,
                    dbId: row.id,
                    username: row.username,
                    rating: row.rating,
                    score: 0,
                    passRequested: false
                }],
                deck: [],
                fieldCards: [],
                currentRound: 1,
                isReviewing: false,
                isGameOver: false,
                message: `${row.username} が部屋を作成しました。メンバーを待っています...`
            };

            socket.join(roomId);
            socket.emit('joinedRoom', rooms[roomId]);
            broadcastLobbyData();
        });
    });

    socket.on('joinRoom', ({ roomId, userId }) => {
        const room = rooms[roomId];
        if (!room || room.isGameStarted || room.players.length >= 4) {
            socket.emit('notify', 'この部屋には参加できません。');
            return;
        }

        db.get(`SELECT id, username, rating FROM users WHERE id = ?`, [userId], (err, row) => {
            if (err || !row) return;
            socket.user = row;

            if (room.players.some(p => p.dbId === row.id)) {
                socket.emit('joinedRoom', room);
                return;
            }

            room.players.push({
                id: socket.id,
                dbId: row.id,
                username: row.username,
                rating: row.rating,
                score: 0,
                passRequested: false
            });

            socket.join(roomId);
            io.to(roomId).emit('updateState', room);
            broadcastLobbyData();
        });
    });

    socket.on('startGame', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.id || room.isGameStarted) return;
        if (room.players.length < 1) {
            socket.emit('notify', 'プレイヤーが足りません。');
            return;
        }

        room.isGameStarted = true;
        room.message = `${room.players.length}人対戦開始！ 5枚すべて使って「15」を作れ！（3本先取）`;
        initGame(room);
        io.to(roomId).emit('updateState', room);
        broadcastLobbyData();
    });

    socket.on('requestPass', ({ roomId, pass }) => {
        const room = rooms[roomId];
        if (!room || !room.isGameStarted || room.isReviewing || room.isGameOver) return;

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
        if (!room || !room.isGameStarted || room.isReviewing || room.isGameOver) return;

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

                    if (player.score >= 3) {
                        room.isGameOver = true;
                        
                        // --- 同点（タイ）を考慮した公平なレート計算処理 ---
                        const sortedPlayers = [...room.players].sort((a, b) => b.score - a.score);
                        const totalPlayers = sortedPlayers.length;

                        // 同じスコアのプレイヤー同士をグループ化
                        let rankGroups = [];
                        let i = 0;
                        while (i < totalPlayers) {
                            let group = [sortedPlayers[i]];
                            let j = i + 1;
                            while (j < totalPlayers && sortedPlayers[j].score === sortedPlayers[i].score) {
                                group.push(sortedPlayers[j]);
                                j++;
                            }
                            rankGroups.push(group);
                            i = j;
                        }

                        // 各グループごとに占める順位範囲のベース変動の平均を計算して割り当て
                        let calculatedChanges = new Map();
                        let currentRankIndex = 0;

                        rankGroups.forEach(group => {
                            let groupSize = group.length;
                            let sumChanges = 0;
                            for (let k = 0; k < groupSize; k++) {
                                sumChanges += getBaseRatingChange(currentRankIndex + k, totalPlayers);
                            }
                            let avgChange = Math.round(sumChanges / groupSize);
                            group.forEach(p => {
                                calculatedChanges.set(p.dbId, avgChange);
                            });
                            currentRankIndex += groupSize;
                        });

                        let processedCount = 0;
                        sortedPlayers.forEach(p => {
                            let change = calculatedChanges.get(p.dbId) || 0;
                            db.get(`SELECT rating FROM users WHERE id = ?`, [p.dbId], (err, row) => {
                                if (!err && row) {
                                    let newRating = Math.max(100, row.rating + change);
                                    db.run(`UPDATE users SET rating = ? WHERE id = ?`, [newRating, p.dbId], () => {
                                        p.rating = newRating;
                                        processedCount++;
                                        if (processedCount === totalPlayers) {
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
                }, 10000);

            } else {
                socket.emit('notify', `計算結果が ${result} です（15ではありません）。`);
            }
        } catch (e) {
            socket.emit('notify', '計算式が無効です。括弧や演算子を確認してください。');
        }
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                if (!room.isGameStarted) {
                    room.players.splice(playerIndex, 1);
                    if (room.players.length === 0) {
                        delete rooms[roomId];
                    } else {
                        if (room.hostId === socket.id) {
                            room.hostId = room.players[0].id;
                            room.hostName = room.players[0].username;
                        }
                        io.to(roomId).emit('updateState', room);
                    }
                } else if (!room.isGameOver) {
                    const disconnectedPlayer = room.players[playerIndex];

                    db.get(`SELECT rating FROM users WHERE id = ?`, [disconnectedPlayer.dbId], (err, row) => {
                        if (!err && row) {
                            let newRating = Math.max(100, row.rating - 16);
                            db.run(`UPDATE users SET rating = ? WHERE id = ?`, [newRating, disconnectedPlayer.dbId], () => {
                                broadcastLobbyData();
                            });
                        }
                    });

                    room.players.splice(playerIndex, 1);

                    if (room.players.length < 2) {
                        room.isGameOver = true;
                        if (room.players.length === 1) {
                            room.message = `⚠️ ${disconnectedPlayer.username} が切断しました。残りのプレイヤー (${room.players[0].username}) の勝利となります！`;
                            const winner = room.players[0];
                            db.get(`SELECT rating FROM users WHERE id = ?`, [winner.dbId], (err, row) => {
                                if (!err && row) {
                                    let newRating = row.rating + 15;
                                    db.run(`UPDATE users SET rating = ? WHERE id = ?`, [newRating, winner.dbId], () => {
                                        winner.rating = newRating;
                                        io.to(roomId).emit('updateState', room);
                                        broadcastLobbyData();
                                    });
                                }
                            });
                        } else {
                            room.message = `⚠️ 参加者がいなくなったため試合終了となりました。`;
                            io.to(roomId).emit('updateState', room);
                        }
                        setTimeout(() => { delete rooms[roomId]; }, 5000);
                    } else {
                        room.message = `⚠️ ${disconnectedPlayer.username} が切断しました（脱落）。ゲームを続行します！`;
                        io.to(roomId).emit('updateState', room);
                    }
                }
            }
        }
        broadcastLobbyData();
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