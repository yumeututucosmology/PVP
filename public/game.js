const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const titleScreen = document.getElementById('title-screen');
const matchingScreen = document.getElementById('matching-screen');
const resultScreen = document.getElementById('result-screen');
const resultText = document.getElementById('result-text');
const startBtn = document.getElementById('start-btn');

let myId = null;
let myIndex = null; // プレイヤー番号 (0 or 1)
let gameState = 'title'; // title, matching, playing, result
let players = {};
let arrows = [];
let config = { playerRadius: 25 };

let lastShootTime = 0;
const SHOOT_COOLDOWN = 500;
let lastSendTime = 0;
const SEND_INTERVAL = 1000 / 60; // 60fpsに戻す

// Canvas setup
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

// Gamepad handling
function getGamepadState() {
    const gamepads = navigator.getGamepads();
    // 自分のプレイヤー番号に対応するゲームパッドを優先的に使用
    if (myIndex !== null && gamepads[myIndex]) {
        return gamepads[myIndex];
    }
    // 見つからない場合は最初に見つかったものを使用（オンライン対戦時など）
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
        // The server automatically puts us in a room on connection
    }
}

startBtn.addEventListener('click', startGame);

// Press any button to start
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
    
    // サーバー上の全プレイヤーデータを処理
    for (const id in data.players) {
        const serverPlayer = data.players[id];
        
        if (id !== myId) {
            // 他プレイヤー：矢と同じくサーバーの位置をそのまま反映（60fpsならこれで滑らか）
            players[id] = serverPlayer;
        } else {
            // 自分：基本は自分の計算を優先し、HPのみ同期
            if (players[myId]) {
                players[myId].hp = serverPlayer.hp;
                // ノックバックなどで位置が大きくズレた場合（100px以上）のみ補正
                const dist = Math.hypot(players[myId].x - serverPlayer.x, players[myId].y - serverPlayer.y);
                if (dist > 100) {
                    players[myId].x = serverPlayer.x;
                    players[myId].y = serverPlayer.y;
                }
            } else {
                players[myId] = serverPlayer;
            }
        }
    }
    
    // 切断されたプレイヤーを削除
    for (const id in players) {
        if (!data.players[id]) {
            delete players[id];
        }
    }
    
    arrows = data.arrows;
});

socket.on('gameOver', (data) => {
    gameState = 'result';
    resultText.innerText = data.winner === myId ? 'YOU WIN!' : 'YOU LOSE';
    resultScreen.classList.remove('hidden');
    setTimeout(() => {
        location.reload();
    }, 3000);
});

socket.on('playerLeft', () => {
    if (gameState === 'playing') {
        alert('Opponent disconnected');
        location.reload();
    }
});

function checkMyArrowHits() {
    const ARROW_HIT_RADIUS = 10;
    for (let i = arrows.length - 1; i >= 0; i--) {
        const arrow = arrows[i];
        if (arrow.ownerId !== myId) continue;

        for (const id in players) {
            if (id === myId) continue;
            const p = players[id];
            const dx = arrow.x - p.x;
            const dy = arrow.y - p.y;
            const dist = Math.hypot(dx, dy);

            if (dist < config.playerRadius + ARROW_HIT_RADIUS) {
                socket.emit('hit', { targetId: id, arrowX: arrow.x, arrowY: arrow.y });
                arrows.splice(i, 1);
                break;
            }
        }
    }
}

function update() {
    const gp = getGamepadState();
    
    // Auto-start with controller
    if (gameState === 'title' && gp) {
        for (let i = 0; i < gp.buttons.length; i++) {
            if (gp.buttons[i].pressed) {
                startGame();
                break;
            }
        }
    }

    if (gameState !== 'playing') return;
    
    checkMyArrowHits();

    if (!gp) return;

    const me = players[myId];
    if (!me) return;

    // Movement (LS - axes 0, 1)
    const moveX = gp.axes[0];
    const moveY = gp.axes[1];
    const threshold = 0.2;
    const speed = 6;

    if (Math.abs(moveX) > threshold) me.x += moveX * speed;
    if (Math.abs(moveY) > threshold) me.y += moveY * speed;

    // Constrain to walls
    me.x = Math.max(config.playerRadius, Math.min(canvas.width - config.playerRadius, me.x));
    me.y = Math.max(config.playerRadius, Math.min(canvas.height - config.playerRadius, me.y));

    // Aiming (RS - axes 2, 3)
    const aimX = gp.axes[2];
    const aimY = gp.axes[3];
    if (Math.abs(aimX) > threshold || Math.abs(aimY) > threshold) {
        me.angle = Math.atan2(aimY, aimX);
    }

    // Shooting (RB - button index 5)
    const rbPressed = gp.buttons[5].pressed;
    const now = Date.now();
    if (rbPressed && now - lastShootTime > SHOOT_COOLDOWN) {
        socket.emit('shoot', { x: me.x, y: me.y, angle: me.angle });
        lastShootTime = now;
    }

    // Send update to server at 30fps
    if (now - lastSendTime > SEND_INTERVAL) {
        socket.emit('update', { x: me.x, y: me.y, angle: me.angle });
        lastSendTime = now;
    }
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (gameState === 'playing' || gameState === 'result') {
        // Draw arrows
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

        // Draw players
        for (const id in players) {
            const p = players[id];
            
            // Draw player body
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

            // Draw nose/pointer
            ctx.fillStyle = 'white';
            ctx.beginPath();
            ctx.moveTo(config.playerRadius, 0);
            ctx.lineTo(config.playerRadius - 10, -10);
            ctx.lineTo(config.playerRadius - 10, 10);
            ctx.closePath();
            ctx.fill();

            ctx.restore();

            // Draw HP bar
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
        update();
        draw();
    });
}

draw();
