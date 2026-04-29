const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {}; // roomID -> { players: {}, arrows: [], state: 'waiting'|'playing' }

// Constants
const FIELD_WIDTH = 1280;
const FIELD_HEIGHT = 720;
const PLAYER_RADIUS = 25;
const ARROW_SPEED = 15;
const ARROW_HIT_RADIUS = 10;
const KNOCKBACK_FORCE = 40;

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Auto-matching logic
    let targetRoomId = Object.keys(rooms).find(id => rooms[id].state === 'waiting' && Object.keys(rooms[id].players).length < 2);
    
    if (!targetRoomId) {
        targetRoomId = 'room_' + Date.now();
        rooms[targetRoomId] = {
            players: {},
            arrows: [],
            state: 'waiting'
        };
    }

    const room = rooms[targetRoomId];
    const playerIndex = Object.keys(room.players).length; 
    const color = playerIndex === 0 ? 'blue' : 'red';
    const startX = playerIndex === 0 ? 200 : FIELD_WIDTH - 200;
    const startY = FIELD_HEIGHT / 2;

    room.players[socket.id] = {
        id: socket.id,
        index: playerIndex,
        x: startX,
        y: startY,
        angle: playerIndex === 0 ? 0 : Math.PI,
        hp: 100,
        color: color
    };

    socket.join(targetRoomId);
    socket.emit('init', { 
        id: socket.id, 
        room: targetRoomId, 
        index: playerIndex, 
        config: { width: FIELD_WIDTH, height: FIELD_HEIGHT, playerRadius: PLAYER_RADIUS } 
    });

    if (Object.keys(room.players).length === 2) {
        room.state = 'playing';
        io.to(targetRoomId).emit('start', { players: room.players });
    }

    socket.on('update', (data) => {
        if (!room.players[socket.id] || room.state !== 'playing') return;
        room.players[socket.id].x = data.x;
        room.players[socket.id].y = data.y;
        room.players[socket.id].angle = data.angle;
    });

    socket.on('shoot', (data) => {
        if (room.state !== 'playing') return;
        room.arrows.push({
            id: Date.now() + '_' + socket.id,
            ownerId: socket.id,
            x: data.x,
            y: data.y,
            vx: Math.cos(data.angle) * ARROW_SPEED,
            vy: Math.sin(data.angle) * ARROW_SPEED,
            angle: data.angle
        });
    });

    socket.on('hit', (data) => {
        if (room.state !== 'playing') return;
        const targetId = data.targetId;
        const p = room.players[targetId];
        if (p) {
            p.hp -= 10;
            // ノックバック
            const dx = p.x - data.arrowX;
            const dy = p.y - data.arrowY;
            const angle = Math.atan2(dy, dx);
            p.x += Math.cos(angle) * KNOCKBACK_FORCE;
            p.y += Math.sin(angle) * KNOCKBACK_FORCE;
            
            p.x = Math.max(PLAYER_RADIUS, Math.min(FIELD_WIDTH - PLAYER_RADIUS, p.x));
            p.y = Math.max(PLAYER_RADIUS, Math.min(FIELD_HEIGHT - PLAYER_RADIUS, p.y));

            if (p.hp <= 0) {
                io.to(targetRoomId).emit('gameOver', { winner: socket.id });
                room.state = 'waiting';
                room.arrows = [];
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        if (room) {
            delete room.players[socket.id];
            if (Object.keys(room.players).length === 0) {
                delete rooms[targetRoomId];
            } else {
                room.state = 'waiting';
                room.arrows = [];
                io.to(targetRoomId).emit('playerLeft');
            }
        }
    });
});

// Server Game Loop (60fps)
setInterval(() => {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        if (room.state !== 'playing') continue;

        // Update arrows
        for (let i = room.arrows.length - 1; i >= 0; i--) {
            const arrow = room.arrows[i];
            if (!arrow) continue; // 安全チェック

            arrow.x += arrow.vx;
            arrow.y += arrow.vy;

            // Wall collision
            if (arrow.x < 0 || arrow.x > FIELD_WIDTH || arrow.y < 0 || arrow.y > FIELD_HEIGHT) {
                room.arrows.splice(i, 1);
                continue;
            }
        }

        io.to(roomId).emit('state', { players: room.players, arrows: room.arrows });
    }
}, 1000 / 30);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
