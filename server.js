const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const VERSION = "v1.9.6";
const MONGO_URL = 'mongodb+srv://e221239_db_user:Y0u667841you@cluster0.yxjjzel.mongodb.net/strawberry_kingdom?retryWrites=true&w=majority&appName=Cluster0';

const DB_NAME = 'strawberry_kingdom';

let db, usersCollection;
let rooms = {};

async function startServer() {
    try {
        const client = await MongoClient.connect(MONGO_URL);
        console.log('MongoDB接続完了:', MONGO_URL);
        db = client.db(DB_NAME);
        usersCollection = db.collection('users');
        const PORT = process.env.PORT || 3000;
        server.listen(PORT, () => {
            console.log(`サーバー起動 (${VERSION}): ポート ${PORT}`);
        });
    } catch (err) {
        console.error('MongoDB接続エラー:', err);
    }
}

startServer();

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, message: '入力してください。' });
    try {
        if (!usersCollection) return res.json({ success: false, message: 'データベースが未接続です。' });
        const existing = await usersCollection.findOne({ username });
        if (existing) return res.json({ success: false, message: 'そのユーザー名は既に使われています。' });
        const result = await usersCollection.insertOne({ username, password, rating: 1000 });
        res.json({ success: true, user: { id: result.insertedId.toString(), username, rating: 1000 } });
    } catch (err) {
        res.json({ success: false, message: '登録エラーが発生しました。' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        if (!usersCollection) return res.json({ success: false, message: 'データベースが未接続です。' });
        const user = await usersCollection.findOne({ username, password });
        if (!user) return res.json({ success: false, message: 'ユーザー名またはパスワードが違います。' });
        res.json({ success: true, user: { id: user._id.toString(), username: user.username, rating: user.rating } });
    } catch (err) {
        res.json({ success: false, message: 'ログインエラーが発生しました。' });
    }
});

function evaluateExpression(expr) {
    let pos = 0;
    function parseNumber() {
        let start = pos;
        while (pos < expr.length && ((expr[pos] >= '0' && expr[pos] <= '9') || expr[pos] === '.')) pos++;
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
            if (expr[pos] === '*') { pos++; val *= parseFactor(); }
            else if (expr[pos] === '/') {
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
            if (expr[pos] === '+') { pos++; val += parseTerm(); }
            else if (expr[pos] === '-') { pos++; val -= parseTerm(); }
            else break;
        }
        return val;
    }
    function skipWhitespace() {
        while (pos < expr.length && expr[pos] === ' ') pos++;
    }
    let val = parseExpression();
    skipWhitespace();
    if (pos < expr.length) throw new Error('無効な式です');
    return val;
}

async function getLobbyInfo() {
    try {
        const ranking = await usersCollection.find({}, { projection: { username: 1, rating: 1 } })
            .sort({ rating: -1 }).limit(10).toArray();
        const formattedRanking = ranking.map(u => ({ username: u.username, rating: u.rating }));
        const roomList = Object.keys(rooms).map(roomId => ({
            roomId,
            host: rooms[roomId].hostName,
            playerCount: rooms[roomId].players.length,
            status: rooms[roomId].isGameStarted ? '対戦中' : '募集中'
        }));
        return { ranking: formattedRanking, roomList };
    } catch (err) {
        return { ranking: [], roomList: [] };
    }
}

async function broadcastLobbyData() {
    const data = await getLobbyInfo();
    io.emit('lobbyData', data);
}

function getBaseRatingChange(rankIndex, totalPlayers) {
    if (totalPlayers === 2) return rankIndex === 0 ? 24 : -12;
    if (rankIndex === 0) return 24;
    if (rankIndex === 1) return 4;
    if (rankIndex === 2) return -8;
    return -16;
}

function initGame(room) {
    if (room.graceTimer) {
        clearTimeout(room.graceTimer);
        room.graceTimer = null;
    }
    room.isGracePeriod = false;
    room.graceTargetUser = null;

    if (room.players) {
        room.players.forEach(p => {
            p.passRequested = false;
            p.currentExpression = '';
            p.hasRejectedGrace = false;
        });
    }
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

function hasPlayerEnteredCardNumber(player, fieldCards) {
    if (!player.currentExpression || !player.currentExpression.trim()) return false;
    const enteredNums = player.currentExpression.match(/\d+/g)?.map(Number) || [];
    return enteredNums.some(num => fieldCards.includes(num));
}

function checkAndProcessPass(room) {
    if (!room.isGameStarted || room.isReviewing || room.isGameOver || room.isGracePeriod) return false;

    const passCount = room.players.filter(p => p.passRequested).length;
    // 過半数の計算：2人なら2人、3人なら2人、4人なら3人
    const requiredPass = Math.floor(room.players.length / 2) + 1;

    if (passCount >= requiredPass) {
        const activeNotPassedPlayers = room.players.filter(p => !p.passRequested);
        const typingPlayer = activeNotPassedPlayers.find(p => hasPlayerEnteredCardNumber(p, room.fieldCards));

        // まだパスしていない人で入力中の人がいる場合（※全員パス済みの場合はtypingPlayerは存在しない）
        if (typingPlayer) {
            room.isGracePeriod = true;
            room.graceTargetUser = typingPlayer.username;
            room.message = `⚠️ パスが成立しましたが、${typingPlayer.username} が解答を入力中のため15秒間待機します。`;
            io.to(room.roomId).emit('updateState', room);

            room.graceTimer = setTimeout(() => {
                if (!rooms[room.roomId] || rooms[room.roomId] !== room) return;
                processTimeoutAutoCalc(room, typingPlayer);
            }, 15000);

            return true;
        } else {
            // 入力中の人がいない（または全員がパスした）場合は即座に次の問題へ
            room.message = '全員の合意または過半数によりパスが成立しました。新しいカードに更新します！';
            initGame(room);
            io.to(room.roomId).emit('updateState', room);
            return true;
        }
    }
    return false;
}

async function processTimeoutAutoCalc(room, player) {
    room.isGracePeriod = false;
    room.graceTimer = null;

    try {
        const expr = player.currentExpression || '';
        const sanitized = expr.replace(/×/g, '*').replace(/÷/g, '/');
        
        let isCorrect = false;
        if (/^[0-9\+\-\*\/\(\)\.\s]+$/.test(sanitized)) {
            const usedNumbers = sanitized.match(/\d+/g)?.map(Number) || [];
            if (usedNumbers.length === room.fieldCards.length) {
                const currentField = [...room.fieldCards];
                let validCards = true;
                for (let num of usedNumbers) {
                    const idx = currentField.indexOf(num);
                    if (idx === -1) { validCards = false; break; }
                    currentField.splice(idx, 1);
                }
                if (validCards) {
                    const result = evaluateExpression(sanitized);
                    if (Math.abs(result - 15) < 1e-9) {
                        isCorrect = true;
                    }
                }
            }
        }

        if (isCorrect) {
            player.score++;
            room.isReviewing = true;
            room.lastCorrectUser = player.username;
            room.lastExpression = expr;
            room.message = `⏰ 15秒猶予終了間際！ ${player.username} が正解！ 「${expr} = 15」`;
            io.to(room.roomId).emit('updateState', room);

            setTimeout(async () => {
                if (!rooms[room.roomId] || rooms[room.roomId] !== room) return;
                if (player.score >= 3) {
                    finishGame(room, player);
                } else {
                    room.currentRound++;
                    room.isReviewing = false;
                    room.lastCorrectUser = null;
                    initGame(room);
                    io.to(room.roomId).emit('updateState', room);
                }
            }, 10000);
        } else {
            room.message = `⏰ 15秒経過：${player.username} の解答は不正解でした。次の問題へ進みます。`;
            initGame(room);
            io.to(room.roomId).emit('updateState', room);
        }
    } catch (e) {
        room.message = `⏰ 15秒経過：計算が無効でした。次の問題へ進みます。`;
        initGame(room);
        io.to(room.roomId).emit('updateState', room);
    }
}

async function finishGame(room, winnerPlayer) {
    room.isGameOver = true;
    const sortedPlayers = [...room.players].sort((a, b) => b.score - a.score);
    const totalPlayers = sortedPlayers.length;

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

    let calculatedChanges = new Map();
    let currentRankIndex = 0;
    rankGroups.forEach(group => {
        let groupSize = group.length;
        let sumChanges = 0;
        for (let k = 0; k < groupSize; k++) {
            sumChanges += getBaseRatingChange(currentRankIndex + k, totalPlayers);
        }
        let avgChange = Math.round(sumChanges / groupSize);
        group.forEach(p => { calculatedChanges.set(p.dbId, avgChange); });
        currentRankIndex += groupSize;
    });

    for (let p of sortedPlayers) {
        let change = totalPlayers === 1 ? 0 : (calculatedChanges.get(p.dbId) || 0);
        try {
            const userDoc = await usersCollection.findOne({ _id: new ObjectId(p.dbId) });
            if (userDoc) {
                let newRating = Math.max(100, userDoc.rating + change);
                await usersCollection.updateOne(
                    { _id: new ObjectId(p.dbId) },
                    { $set: { rating: newRating } }
                );
                p.rating = newRating;
            }
        } catch (err) { console.error(err); }
    }

    room.message = `🏆 試合終了！ 勝者: ${sortedPlayers[0].username} 🎉`;
    io.to(room.roomId).emit('updateState', room);
    broadcastLobbyData();
}

io.on('connection', (socket) => {
    socket.on('restoreSession', async (userId, callback) => {
        try {
            if (!ObjectId.isValid(userId)) return callback({ success: false });
            const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
            if (!user) callback({ success: false });
            else {
                callback({ success: true, user: { id: user._id.toString(), username: user.username, rating: user.rating } });
            }
        } catch (err) { callback({ success: false }); }
    });

    socket.on('requestLobbyData', async () => {
        const data = await getLobbyInfo();
        socket.emit('lobbyData', data);
    });

    socket.on('createRoom', async ({ userId }) => {
        try {
            if (!ObjectId.isValid(userId)) return;
            const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
            if (!user) return;

            const roomId = 'room_' + Date.now();
            rooms[roomId] = {
                roomId,
                version: VERSION,
                hostId: socket.id,
                hostName: user.username,
                isGameStarted: false,
                players: [{
                    id: socket.id,
                    dbId: user._id.toString(),
                    username: user.username,
                    rating: user.rating,
                    score: 0,
                    passRequested: false,
                    currentExpression: '',
                    hasRejectedGrace: false
                }],
                deck: [],
                fieldCards: [],
                currentRound: 1,
                isReviewing: false,
                isGracePeriod: false,
                graceTargetUser: null,
                graceTimer: null,
                isGameOver: false,
                message: `${user.username} が部屋を作成しました。メンバーを待っています...`
            };

            socket.join(roomId);
            socket.emit('joinedRoom', rooms[roomId]);
            broadcastLobbyData();
        } catch (err) { console.error(err); }
    });

    socket.on('joinRoom', async ({ roomId, userId }) => {
        const room = rooms[roomId];
        if (!room || room.isGameStarted || room.players.length >= 4) {
            socket.emit('notify', 'この部屋には参加できません。');
            return;
        }

        try {
            if (!ObjectId.isValid(userId)) return;
            const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
            if (!user) return;

            if (room.players.some(p => p.dbId === user._id.toString())) {
                socket.emit('joinedRoom', room);
                return;
            }

            room.players.push({
                id: socket.id,
                dbId: user._id.toString(),
                username: user.username,
                rating: user.rating,
                score: 0,
                passRequested: false,
                currentExpression: '',
                hasRejectedGrace: false
            });

            socket.join(roomId);
            io.to(roomId).emit('updateState', room);
            broadcastLobbyData();
        } catch (err) { console.error(err); }
    });

    socket.on('startGame', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.id || room.isGameStarted) return;
        room.isGameStarted = true;
        room.message = `${room.players.length}人対戦開始！ 5枚すべて使って「15」を作れ！（3本先取）`;
        initGame(room);
        io.to(roomId).emit('updateState', room);
        broadcastLobbyData();
    });

    socket.on('updateExpression', ({ roomId, expression }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.currentExpression = expression;
        }
    });

    socket.on('acceptPass', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || !room.isGracePeriod) return;
        
        if (room.graceTimer) {
            clearTimeout(room.graceTimer);
            room.graceTimer = null;
        }
        room.message = 'パスが承諾されました。新しい問題に切り替えます！';
        initGame(room);
        io.to(roomId).emit('updateState', room);
    });

    socket.on('rejectPass', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.hasRejectedGrace = true;
            socket.emit('updateState', room);
        }
    });

    socket.on('requestPass', ({ roomId, pass }) => {
        const room = rooms[roomId];
        if (!room || !room.isGameStarted || room.isReviewing || room.isGameOver || room.isGracePeriod) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        player.passRequested = pass;

        if (checkAndProcessPass(room)) {
            // パス成立
        } else {
            const passCount = room.players.filter(p => p.passRequested).length;
            const requiredPass = Math.floor(room.players.length / 2) + 1;
            room.message = `${player.username} がパスを希望しています (${passCount}/${requiredPass})`;
            io.to(roomId).emit('updateState', room);
        }
    });

    socket.on('tryCalc', ({ roomId, expression }) => {
        const room = rooms[roomId];
        if (!room || !room.isGameStarted || room.isReviewing || room.isGameOver) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        if (room.isGracePeriod && room.graceTimer) {
            clearTimeout(room.graceTimer);
            room.graceTimer = null;
            room.isGracePeriod = false;
        }

        try {
            const sanitized = expression.replace(/×/g, '*').replace(/÷/g, '/');
            if (!/^[0-9\+\-\*\/\(\)\.\s]+$/.test(sanitized)) throw new Error('無効な文字');

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
                room.lastCorrectUser = player.username;
                room.lastExpression = expression;
                room.message = `🎉 ${player.username} が正解！ 「${expression} = 15」`;
                io.to(roomId).emit('updateState', room);

                setTimeout(async () => {
                    if (!rooms[roomId] || rooms[roomId] !== room) return;
                    if (player.score >= 3) {
                        finishGame(room, player);
                    } else {
                        room.currentRound++;
                        room.isReviewing = false;
                        room.lastCorrectUser = null;
                        initGame(room);
                        io.to(roomId).emit('updateState', room);
                    }
                }, 10000);

            } else {
                socket.emit('notify', `計算結果が ${result} です（15ではありません）。`);
            }
        } catch (e) {
            socket.emit('notify', '計算式が無効です。括弧や演算子を確認してください。');
        }
    });

    socket.on('leaveGame', async ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;

        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
            const leavingPlayer = room.players[playerIndex];

            if (room.isGameStarted && !room.isGameOver) {
                try {
                    const userDoc = await usersCollection.findOne({ _id: new ObjectId(leavingPlayer.dbId) });
                    if (userDoc) {
                        let newRating = Math.max(100, userDoc.rating - 16);
                        await usersCollection.updateOne({ _id: new ObjectId(leavingPlayer.dbId) }, { $set: { rating: newRating } });
                        broadcastLobbyData();
                    }
                } catch (err) { console.error(err); }
            }

            room.players.splice(playerIndex, 1);
            if (room.isGameStarted && !room.isGameOver) checkAndProcessPass(room);

            if (!room.isGameStarted) {
                if (room.players.length === 0) delete rooms[roomId];
                else {
                    if (room.hostId === socket.id) {
                        room.hostId = room.players[0].id;
                        room.hostName = room.players[0].username;
                    }
                    io.to(roomId).emit('updateState', room);
                }
            } else if (!room.isGameOver) {
                if (room.players.length < 2) {
                    room.isGameOver = true;
                    if (room.players.length === 1) {
                        room.message = `⚠️ ${leavingPlayer.username} が退出しました。残りのプレイヤー (${room.players[0].username}) の勝利となります！`;
                        const winner = room.players[0];
                        try {
                            const userDoc = await usersCollection.findOne({ _id: new ObjectId(winner.dbId) });
                            if (userDoc) {
                                let newRating = userDoc.rating + 15;
                                await usersCollection.updateOne({ _id: new ObjectId(winner.dbId) }, { $set: { rating: newRating } });
                                winner.rating = newRating;
                                io.to(roomId).emit('updateState', room);
                                broadcastLobbyData();
                            }
                        } catch (err) { console.error(err); }
                    } else {
                        room.message = `⚠️ 参加者がいなくなったため試合終了となりました。`;
                        io.to(roomId).emit('updateState', room);
                    }
                    setTimeout(() => { delete rooms[roomId]; }, 5000);
                } else {
                    room.message = `⚠️ ${leavingPlayer.username} が退出しました。ゲームを続行します！`;
                    io.to(roomId).emit('updateState', room);
                }
            }
        }
        broadcastLobbyData();
    });

    socket.on('disconnect', async () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                if (!room.isGameStarted) {
                    room.players.splice(playerIndex, 1);
                    if (room.players.length === 0) delete rooms[roomId];
                    else {
                        if (room.hostId === socket.id) {
                            room.hostId = room.players[0].id;
                            room.hostName = room.players[0].username;
                        }
                        io.to(roomId).emit('updateState', room);
                    }
                } else if (!room.isGameOver) {
                    const disconnectedPlayer = room.players[playerIndex];
                    try {
                        const userDoc = await usersCollection.findOne({ _id: new ObjectId(disconnectedPlayer.dbId) });
                        if (userDoc) {
                            let newRating = Math.max(100, userDoc.rating - 16);
                            await usersCollection.updateOne({ _id: new ObjectId(disconnectedPlayer.dbId) }, { $set: { rating: newRating } });
                            broadcastLobbyData();
                        }
                    } catch (err) { console.error(err); }

                    room.players.splice(playerIndex, 1);
                    if (!room.isGameOver) checkAndProcessPass(room);

                    if (room.players.length < 2) {
                        room.isGameOver = true;
                        if (room.players.length === 1) {
                            room.message = `⚠️ ${disconnectedPlayer.username} が切断しました。残りのプレイヤー (${room.players[0].username}) の勝利となります！`;
                            const winner = room.players[0];
                            try {
                                const userDoc = await usersCollection.findOne({ _id: new ObjectId(winner.dbId) });
                                if (userDoc) {
                                    let newRating = userDoc.rating + 15;
                                    await usersCollection.updateOne({ _id: new ObjectId(winner.dbId) }, { $set: { rating: newRating } });
                                    winner.rating = newRating;
                                    io.to(roomId).emit('updateState', room);
                                    broadcastLobbyData();
                                }
                            } catch (err) { console.error(err); }
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