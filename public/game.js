const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const titleScreen = document.getElementById('title-screen');
const matchingScreen = document.getElementById('matching-screen');
const resultScreen = document.getElementById('result-screen');
const resultText = document.getElementById('result-text');
const startBtn = document.getElementById('start-btn');

let myId = null;
let myIndex = null;
let gameState = 'title'; // title, matching, playing, result
let players = {};
let arrows = [];
let config = { playerRadius: 25 };

let lastShootTime = 0;
const SHOOT_COOLDOWN = 500;
let lastSendTime = 0;
const SEND_INTERVAL = 1000 / 60;
let lastFrameTime = performance.now();

function resizeCanvas() {
    const targetWidth = 1280;
    const targetHeight = 720;
    const ratio = targetWidth / targetHeight;
    let w = window.innerWidth;
    let h = window.innerHeight;

    if (w / h > ratio) {
        w = h * ratio;
    } else {
        h = w / ratio;
    }

    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = targetWidth;
    canvas.height = targetHeight;
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function getGamepadState() {
    const gamepads = navigator.getGamepads();
    if (myIndex !== null && gamepads[myIndex]) {
        return gamepads[myIndex];
    }
    for (const gp of gamepads) {
        if (gp) return gp;
    }
    return null;
}

function startGame() {
    if (gameState === 'title') {
        gameState = 'matching';
        titleScreen.classList.add('hidden');
        matchingScreen.classList.remove('hidden');
    }
}

startBtn.addEventListener('click', startGame);
window.addEventListener('keydown', startGame);

socket.on('init', (data) => {
    myId = data.id;
    myIndex = data.index;
    config = data.config;
});

socket.on('start', (data) => {
    players = data.players;
    gameState = 'playing';
    titleScreen.classList.add('hidden');
    matchingScreen.classList.add('hidden');
});

socket.on('state', (data) => {
    if (gameState !== 'playing') return;
    
    for (const id in data.players) {
        const serverPlayer = data.players[id];
        if (id !== myId) {
            players[id] = serverPlayer;
        } else {
            if (players[myId]) {
                players[myId].hp = serverPlayer.hp;
                const dist = Math.hypot(players[myId].x - serverPlayer.x, players[myId].y - serverPlayer.y);
                if (dist > 300) {
                    players[myId].x = serverPlayer.x;
                    players[myId].y = serverPlayer.y;
                }
            } else {
                players[myId] = serverPlayer;
            }
        }
    }
    
    for (const id in players) {
        if (!data.players[id]) delete players[id];
    }
    arrows = data.arrows;
});

socket.on('gameOver', (data) => {
    gameState = 'result';
    resultText.innerText = data.winner === myId ? 'YOU WIN!' : 'YOU LOSE';
    resultScreen.classList.remove('hidden');
    setTimeout(() => { location.reload(); }, 3000);
});

socket.on('playerLeft', () => {
    if (gameState === 'playing') {
        alert('Opponent disconnected');
        location.reload();
    }
});

// 自分への当たり判定チェック
function checkHitsOnMe() {
    const me = players[myId];
    if (!me || gameState !== 'playing') return;

    const ARROW_HIT_RADIUS = 10;
    const ARROW_SPEED = 15;

    for (let i = arrows.length - 1; i >= 0; i--) {
        const arrow = arrows[i];
        if (arrow.ownerId === myId) continue;

        let hitFound = false;
        for (let step = 0; step <= 3; step++) {
            const ratio = step / 3;
            const checkX = arrow.x - (Math.cos(arrow.angle) * ARROW_SPEED * (1 - ratio));
            const checkY = arrow.y - (Math.sin(arrow.angle) * ARROW_SPEED * (1 - ratio));

            const dx = checkX - me.x;
            const dy = checkY - me.y;
            const dist = Math.hypot(dx, dy);

            if (dist < config.playerRadius + ARROW_HIT_RADIUS) {
                // ノックバック計算
                const kAngle = Math.atan2(me.y - checkY, me.x - checkX);
                me.x += Math.cos(kAngle) * 40;
                me.y += Math.sin(kAngle) * 40;
                
                socket.emit('hitMe', { x: me.x, y: me.y });
                arrows.splice(i, 1);
                hitFound = true;
                break;
            }
        }
        if (hitFound) break;
    }
}

function update(dt) {
    const gp = getGamepadState();
    if (gameState === 'title' && gp) {
        for (let i = 0; i < gp.buttons.length; i++) {
            if (gp.buttons[i].pressed) { startGame(); break; }
        }
    }

    if (gameState !== 'playing') return;
    
    // 自分が当たったかどうかを自分で判定
    checkHitsOnMe();

    if (!gp) return;

    const me = players[myId];
    if (!me) return;

    const moveX = gp.axes[0];
    const moveY = gp.axes[1];
    const threshold = 0.2;
    const speed = 7 * dt;

    if (Math.abs(moveX) > threshold) me.x += moveX * speed;
    if (Math.abs(moveY) > threshold) me.y += moveY * speed;

    me.x = Math.max(config.playerRadius, Math.min(canvas.width - config.playerRadius, me.x));
    me.y = Math.max(config.playerRadius, Math.min(canvas.height - config.playerRadius, me.y));

    const aimX = gp.axes[2];
    const aimY = gp.axes[3];
    if (Math.abs(aimX) > threshold || Math.abs(aimY) > threshold) {
        me.angle = Math.atan2(aimY, aimX);
    }

    const rbPressed = gp.buttons[5].pressed;
    const now = Date.now();
    if (rbPressed && now - lastShootTime > SHOOT_COOLDOWN) {
        socket.emit('shoot', { x: me.x, y: me.y, angle: me.angle });
        lastShootTime = now;
    }

    if (now - lastSendTime > SEND_INTERVAL) {
        socket.emit('update', { x: me.x, y: me.y, angle: me.angle });
        lastSendTime = now;
    }
}

function draw() {
    const now = performance.now();
    const dt = (now - lastFrameTime) / (1000 / 60);
    lastFrameTime = now;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (gameState === 'playing' || gameState === 'result') {
        arrows.forEach(arrow => {
            ctx.save();
            ctx.translate(arrow.x, arrow.y);
            ctx.rotate(arrow.angle);
            ctx.fillStyle = 'white';
            ctx.beginPath();
            ctx.moveTo(15, 0);
            ctx.lineTo(-5, -7);
            ctx.lineTo(-5, 7);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        });

        for (const id in players) {
            const p = players[id];
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.angle);
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(0, 0, config.playerRadius, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 3;
            ctx.stroke();
            ctx.fillStyle = 'white';
            ctx.beginPath();
            ctx.moveTo(config.playerRadius, 0);
            ctx.lineTo(config.playerRadius - 10, -10);
            ctx.lineTo(config.playerRadius - 10, 10);
            ctx.closePath();
            ctx.fill();
            ctx.restore();

            const barWidth = 80;
            const barHeight = 10;
            const barY = p.y - config.playerRadius - 25;
            ctx.fillStyle = '#444';
            ctx.fillRect(p.x - barWidth / 2, barY, barWidth, barHeight);
            ctx.fillStyle = p.hp > 30 ? (p.id === myId ? '#2196F3' : '#F44336') : '#FFEB3B';
            ctx.fillRect(p.x - barWidth / 2, barY, (p.hp / 100) * barWidth, barHeight);
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 1;
            ctx.strokeRect(p.x - barWidth / 2, barY, barWidth, barHeight);
        }
    }

    requestAnimationFrame(() => {
        update(dt);
        draw();
    });
}

draw();
