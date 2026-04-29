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
let gameState = 'title';
let players = {};
let arrows = [];
let config = { playerRadius: 25 };

let lastShootTime = 0;
const SHOOT_COOLDOWN = 500;
let lastDashTime = 0;
const DASH_COOLDOWN = 1000;
const DASH_DURATION = 300;
let lastSendTime = 0;
const SEND_INTERVAL = 1000 / 60;
let lastFrameTime = performance.now();

function resizeCanvas() {
    const targetWidth = 1280;
    const targetHeight = 720;
    const ratio = targetWidth / targetHeight;
    let w = window.innerWidth;
    let h = window.innerHeight;
    if (w / h > ratio) { w = h * ratio; } else { h = w / ratio; }
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = targetWidth;
    canvas.height = targetHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function getGamepadState() {
    const gamepads = navigator.getGamepads();
    if (myIndex !== null && gamepads[myIndex]) return gamepads[myIndex];
    for (const gp of gamepads) { if (gp) return gp; }
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
    for (const id in players) { if (!data.players[id]) delete players[id]; }
    arrows = data.arrows;
});

socket.on('gameOver', (data) => {
    gameState = 'result';
    resultText.innerText = data.winner === myId ? 'YOU WIN!' : 'YOU LOSE';
    resultScreen.classList.remove('hidden');
    setTimeout(() => { location.reload(); }, 3000);
});

socket.on('playerLeft', () => {
    if (gameState === 'playing') { alert('Opponent disconnected'); location.reload(); }
});

function checkHitsOnMe() {
    const me = players[myId];
    if (!me || gameState !== 'playing') return;

    // 矢の判定
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
            const dist = Math.hypot(checkX - me.x, checkY - me.y);
            if (dist < config.playerRadius + ARROW_HIT_RADIUS) {
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

    // 突進（ダッシュ）の判定
    for (const id in players) {
        if (id === myId) continue;
        const p = players[id];
        if (p.isDashing) {
            const dist = Math.hypot(me.x - p.x, me.y - p.y);
            if (dist < config.playerRadius * 2 + 10) {
                // 突進に当たった！
                const kAngle = Math.atan2(me.y - p.y, me.x - p.x);
                me.x += Math.cos(kAngle) * 60; // 矢より強めのノックバック
                me.y += Math.sin(kAngle) * 60;
                socket.emit('hitMe', { x: me.x, y: me.y });
                // 連続ヒット防止のため相手のダッシュフラグをローカルで一旦消す（次のStateで上書きされますが）
                p.isDashing = false;
            }
        }
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
    checkHitsOnMe();
    if (!gp) return;

    const me = players[myId];
    if (!me) return;

    const now = Date.now();
    
    // 突進（ダッシュ）処理
    const lbPressed = gp.buttons[4].pressed;
    if (lbPressed && now - lastDashTime > DASH_COOLDOWN) {
        me.isDashing = true;
        lastDashTime = now;
    }
    if (me.isDashing && now - lastDashTime > DASH_DURATION) {
        me.isDashing = false;
    }

    const moveX = gp.axes[0];
    const moveY = gp.axes[1];
    const threshold = 0.2;
    let speed = 7 * dt;
    if (me.isDashing) speed *= 3; // 突進中は3倍速

    if (Math.abs(moveX) > threshold) me.x += moveX * speed;
    if (Math.abs(moveY) > threshold) me.y += moveY * speed;

    // 重なり防止
    for (const id in players) {
        if (id === myId) continue;
        const p = players[id];
        const dx = me.x - p.x;
        const dy = me.y - p.y;
        const dist = Math.hypot(dx, dy);
        const minDist = config.playerRadius * 2;
        if (dist < minDist) {
            const angle = Math.atan2(dy, dx);
            const overlap = minDist - dist;
            me.x += Math.cos(angle) * overlap;
            me.y += Math.sin(angle) * overlap;
        }
    }

    me.x = Math.max(config.playerRadius, Math.min(canvas.width - config.playerRadius, me.x));
    me.y = Math.max(config.playerRadius, Math.min(canvas.height - config.playerRadius, me.y));

    const aimX = gp.axes[2];
    const aimY = gp.axes[3];
    if (Math.abs(aimX) > threshold || Math.abs(aimY) > threshold) {
        me.angle = Math.atan2(aimY, aimX);
    }

    const rbPressed = gp.buttons[5].pressed;
    if (rbPressed && now - lastShootTime > SHOOT_COOLDOWN) {
        socket.emit('shoot', { x: me.x, y: me.y, angle: me.angle });
        lastShootTime = now;
    }

    if (now - lastSendTime > SEND_INTERVAL) {
        socket.emit('update', { x: me.x, y: me.y, angle: me.angle, isDashing: me.isDashing });
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
            ctx.save(); ctx.translate(arrow.x, arrow.y); ctx.rotate(arrow.angle);
            ctx.fillStyle = 'white'; ctx.beginPath(); ctx.moveTo(15, 0); ctx.lineTo(-5, -7); ctx.lineTo(-5, 7); ctx.closePath(); ctx.fill(); ctx.restore();
        });
        for (const id in players) {
            const p = players[id];
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.angle);
            
            // 突進中は残像を出すか色を変える
            if (p.isDashing) {
                ctx.shadowBlur = 15;
                ctx.shadowColor = 'white';
                ctx.fillStyle = 'white';
            } else {
                ctx.fillStyle = p.color;
            }
            
            ctx.beginPath(); ctx.arc(0, 0, config.playerRadius, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = 'white'; ctx.lineWidth = 3; ctx.stroke();
            ctx.fillStyle = 'white'; ctx.beginPath(); ctx.moveTo(config.playerRadius, 0); ctx.lineTo(config.playerRadius - 10, -10); ctx.lineTo(config.playerRadius - 10, 10); ctx.closePath(); ctx.fill();
            ctx.restore();

            const barWidth = 80;
            const barHeight = 10;
            const barY = p.y - config.playerRadius - 25;
            ctx.fillStyle = '#444'; ctx.fillRect(p.x - barWidth / 2, barY, barWidth, barHeight);
            ctx.fillStyle = p.hp > 30 ? (p.id === myId ? '#2196F3' : '#F44336') : '#FFEB3B';
            ctx.fillRect(p.x - barWidth / 2, barY, (p.hp / 100) * barWidth, barHeight);
            ctx.strokeStyle = 'white'; ctx.lineWidth = 1; ctx.strokeRect(p.x - barWidth / 2, barY, barWidth, barHeight);
        }
    }
    requestAnimationFrame(() => { update(dt); draw(); });
}
draw();
