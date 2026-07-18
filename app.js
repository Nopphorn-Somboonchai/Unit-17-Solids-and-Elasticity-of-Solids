// Utility Functions (Performance Optimization)
function throttle(func, limit) {
    let inThrottle;
    return function () {
        const args = arguments;
        const context = this;
        if (!inThrottle) {
            func.apply(context, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    }
}

function debounce(func, delay) {
    let debounceTimer;
    return function () {
        const context = this;
        const args = arguments;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => func.apply(context, args), delay);
    }
}

let mathJaxQueue = Promise.resolve();
function queueTypeset(element) {
    if (typeof MathJax !== 'undefined' && MathJax.typesetPromise) {
        mathJaxQueue = mathJaxQueue.then(() => {
            MathJax.typesetClear([element]);
            return MathJax.typesetPromise([element]).catch(err => console.log(err));
        });
    }
}

// ==========================================
// RANDOM UTILITY FUNCTIONS (Seeded RNG)
// ==========================================

class SeededRNG {
    constructor(seedStr) {
        let hash = 0;
        for (let i = 0; i < seedStr.length; i++) hash = (hash * 31 + seedStr.charCodeAt(i)) | 0;
        this.seed = hash || 1;
    }
    random() {
        let t = this.seed += 0x6D2B79F5;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    shuffle(array) {
        const arr = [...array];
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(this.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }
}

function getSeededRandomBase(questionId, seed, min, max, step = 1) {
    const seedStr = `${questionId}_${seed}`;
    const rng = new SeededRNG(seedStr);
    const steps = Math.floor((max - min) / step);
    return min + Math.floor(rng.random() * (steps + 1)) * step;
}

function getOffsetFromR(r) {
    if (!r) return 0;
    if (typeof r === 'string') {
        if (r.includes('_')) {
            const studentNum = parseInt(r.split('_')[0], 10);
            return Number.isFinite(studentNum) ? studentNum : 0;
        }
        const parsed = parseInt(r, 10);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    if (typeof r === 'number') {
        return (r % 9) + 1; // offset 1-9 to keep calculations clean
    }
    return 0;
}

function normalizeStudentNumber(n) {
    const parsed = parseInt(n, 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

// ==========================================
// SYSTEM STATE & STORAGE UTILITIES
// ==========================================

const HISTORY_KEY = 'solids_question_history';

function getHistory() {
    if (typeof window === 'undefined') return [];
    try {
        const data = localStorage.getItem(HISTORY_KEY);
        return data ? JSON.parse(data) : [];
    } catch (e) {
        console.error('Failed to read from localStorage', e);
        return [];
    }
}

function addToHistory(uniqueKey) {
    if (typeof window === 'undefined') return;
    try {
        let history = getHistory();
        history = history.filter(key => key !== uniqueKey);
        history.push(uniqueKey);
        if (history.length > 100) {
            history = history.slice(history.length - 100);
        }
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (e) {
        console.error('Failed to write to localStorage', e);
    }
}

function getActiveParamValues(params) {
    const values = [];
    for (const key in params) {
        if (key !== 'r' && key !== 'offset' && !key.endsWith('_base') && typeof params[key] === 'number') {
            values.push(params[key]);
        }
    }
    return values;
}

function hasDuplicateVariables(params) {
    const vals = getActiveParamValues(params);
    const set = new Set(vals);
    return set.size !== vals.length;
}

function generateUniqueKey(templateId, params) {
    const vals = [];
    const keys = Object.keys(params).filter(k => k !== 'r' && k !== 'offset' && !k.endsWith('_base'));
    keys.sort();
    keys.forEach(k => {
        if (typeof params[k] === 'number') {
            vals.push(`${k}:${Number(params[k].toFixed(4))}`);
        } else {
            vals.push(`${k}:${params[k]}`);
        }
    });
    return `${templateId}[${vals.join(',')}]`;
}

const g = 9.8;

// System State Variables
let currentSection = 'home';
let currentPracticeTopic = '17-1-1';
let currentPracticeQuestion = null;
let practiceHistory = {}; // Store { 'topic_name': [template_id_1, template_id_2] }

// Exam State
let currentExamQuestions = [];
let examTimerInterval = null;
let examTimeRemaining = 900; // 15 mins
let examDurationSeconds = 900;
const EXAM_STATE_KEY = 'exam_session_solids_17_1';
let examStartTimestamp = null;
let examDeadlineTimestamp = null;
let examIsActive = false;
let examSubmissionInProgress = false;
let examStudentInfo = {};
let examSeed = null;
let examExitGuardEnabled = false;

// --- Helper Math / Format Functions ---
function cleanAndParseNumber(str) {
    let clean = str.trim().toLowerCase().replace(/\\times/g, 'e').replace(/x/g, 'e').replace(/\*/g, 'e').replace(/10\^/g, '').replace(/\{/g, '').replace(/\}/g, '').replace(/\s+/g, '');
    if (clean.includes('e')) {
        const parts = clean.split('e');
        return parseFloat(parts[0]) * Math.pow(10, parseFloat(parts[1]));
    }
    return parseFloat(clean);
}

function isNumericAnswerCorrect(userStr, targetNumOrArr) {
    if (!userStr) return false;
    const parsedUser = cleanAndParseNumber(userStr);
    if (isNaN(parsedUser)) return false;
    const targets = Array.isArray(targetNumOrArr) ? targetNumOrArr : [targetNumOrArr];
    return targets.some(targetNum => {
        if (Math.abs(targetNum) < 1e-9) return Math.abs(parsedUser) < 1e-9;
        return Math.abs(parsedUser - targetNum) / Math.abs(targetNum) < 0.05; // 5% tolerance
    });
}

function formatExamTime(seconds) {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

function formatScientificLaTeX(num, precision = 2, forceScientific = false) {
    if (num === null || num === undefined || isNaN(num)) return '';
    const absVal = Math.abs(num);
    if (absVal === 0) return '0';
    if (forceScientific || absVal >= 1e4 || absVal < 1e-3) {
        const str = num.toExponential(precision);
        const parts = str.split('e');
        const base = parts[0];
        const exp = parseInt(parts[1], 10);
        return `${base} \\times 10^{${exp}}`;
    }
    if (Number.isInteger(num)) return num.toString();
    return num.toFixed(precision);
}

// --- Navigation & Core UI ---
function showSection(sectionId) {
    let norm = sectionId.startsWith('sec-') ? sectionId.slice(4) : sectionId;
    if (examIsActive && !['exam-live', 'exam-result'].includes(norm)) {
        triggerAlert("กำลังสอบ", "กรุณาส่งข้อสอบก่อนออกจากหน้าสอบครับ", "fa-lock", "bg-red-100 text-red-600");
        norm = 'exam-live';
    }
    document.getElementById('mobile-menu').classList.add('hidden');

    ['home', 'review', 'practice', 'exam-start', 'exam-live', 'exam-result'].forEach(s => {
        const sec = document.getElementById('sec-' + s);
        if (sec) sec.classList.toggle('hidden', s !== norm);
    });

    if (norm !== 'exam-live' && !examIsActive) clearInterval(examTimerInterval);
    currentSection = norm;
    window.scrollTo(0, 0);

    // Initializations for simulators
    stopSimulations();
    if (norm === 'review') {
        const activeTab = document.getElementById('btn-tab-17-1-1').classList.contains('bg-white') ? '17-1-1' : '17-1-3';
        if (activeTab === '17-1-1') initElasticSim();
        if (activeTab === '17-1-3') initYmSim();
    }

    renderMath();
}

function toggleMobileMenu() {
    document.getElementById('mobile-menu').classList.toggle('hidden');
}

function triggerAlert(title, message, iconClass = 'fa-info', colorClass = 'bg-slate-100 text-slate-800') {
    const m = document.getElementById('modal-alert'), c = document.getElementById('modal-alert-card'), i = document.getElementById('modal-alert-icon');
    document.getElementById('modal-alert-title').innerText = title;
    document.getElementById('modal-alert-msg').innerText = message;
    i.className = `w-16 h-16 rounded-full mx-auto flex items-center justify-center text-3xl ${colorClass}`;
    i.innerHTML = `<i class="fa-solid ${iconClass}"></i>`;
    m.classList.remove('hidden');
    setTimeout(() => { c.classList.remove('scale-95', 'opacity-0'); }, 10);
}

function closeAlertModal() {
    const m = document.getElementById('modal-alert'), c = document.getElementById('modal-alert-card');
    c.classList.add('scale-95', 'opacity-0');
    setTimeout(() => { m.classList.add('hidden'); }, 200);
}

function renderMath() {
    if (typeof MathJax !== 'undefined' && MathJax.typesetPromise) {
        MathJax.typesetPromise().catch(err => console.log(err));
    }
}

// --- Review Tabs Logic ---
function switchReviewTab(tabName) {
    ['17-1-1', '17-1-3'].forEach(t => {
        const btn = document.getElementById(`btn-tab-${t}`), tab = document.getElementById(`review-tab-${t}`);
        if (t === tabName) {
            btn.className = "flex-1 min-w-[140px] text-center py-2 text-xs md:text-sm font-bold rounded-lg transition-all duration-200 bg-white text-cyan-800 shadow-sm border border-slate-200/50";
            tab.classList.remove('hidden');
        } else {
            btn.className = "flex-1 min-w-[140px] text-center py-2 text-xs md:text-sm font-bold rounded-lg transition-all duration-200 text-slate-500 hover:text-slate-800 hover:bg-slate-200/50";
            tab.classList.add('hidden');
        }
    });
    stopSimulations();
    if (tabName === '17-1-1') initElasticSim();
    if (tabName === '17-1-3') initYmSim();
}

let activeAnimFrame = null;
function stopSimulations() {
    if (activeAnimFrame) cancelAnimationFrame(activeAnimFrame);
}

// ==========================================
// SIMULATOR 1: Elastic vs Plastic Deformation
// ==========================================

let maxForceApplied = 0;

function initElasticSim() {
    stopSimulations();
    const canvas = document.getElementById('sim-elastic-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const slider = document.getElementById('sim-elastic-slider');
    const materialSelect = document.getElementById('sim-elastic-material');
    const lblForce = document.getElementById('lbl-sim-elastic-force');
    const lblStress = document.getElementById('lbl-sim-elastic-stress');
    const lblStrain = document.getElementById('lbl-sim-elastic-strain');
    const lblState = document.getElementById('lbl-sim-elastic-state');

    maxForceApplied = 0; // Reset max force memory on init

    // Physical configurations for each material:
    // Y (Young's Modulus in Pa), Area (m2), E_Limit (Force in N), F_Limit (Force in N)
    const configs = {
        steel: { name: 'เหล็กกล้า', Y: 20e10, area: 1e-6, elasticF: 350, fractureF: 750, color: '#38bdf8' },
        copper: { name: 'ทองแดง', Y: 11e10, area: 1e-6, elasticF: 180, fractureF: 450, color: '#fb923c' },
        rubber: { name: 'ยางยืด', Y: 0.05e10, area: 2e-6, elasticF: 500, fractureF: 950, color: '#ec4899' },
        clay: { name: 'ดินน้ำมัน', Y: 0.005e10, area: 5e-6, elasticF: 10, fractureF: 200, color: '#a8a29e' }
    };

    const updateOutputs = () => {
        const matKey = materialSelect.value;
        const conf = configs[matKey];
        const currentF = parseFloat(slider.value);

        // Keep track of maximum applied force to calculate permanent deformation (plasticity)
        if (currentF > maxForceApplied) {
            maxForceApplied = currentF;
        }

        lblForce.innerText = currentF + ' N';

        let stress = currentF / conf.area;
        let strain = 0;
        let isFractured = maxForceApplied >= conf.fractureF;

        if (isFractured) {
            stress = 0; // Broken wire transmits no stress
            strain = (conf.fractureF / conf.Y) * 3; // Keep drawing snapped stretched wire
            lblState.innerText = "แตกหักถาวร (Fractured)";
            lblState.className = "font-bold text-red-500 animate-pulse";
        } else if (maxForceApplied > conf.elasticF) {
            // Plastic region: permanent strain remains
            const permF = maxForceApplied - conf.elasticF;
            const permStrain = (permF / conf.Y) * 15; // Material stretches 15x faster plastically
            const elasticStrain = currentF <= conf.elasticF ? (currentF / conf.Y) : (conf.elasticF / conf.Y);
            strain = permStrain + elasticStrain;
            lblState.innerText = "สภาพพลาสติก (Permanent Deformation)";
            lblState.className = "font-bold text-orange-400";
        } else {
            // Elastic region: fully reversible
            strain = currentF / conf.Y;
            if (currentF === 0) {
                lblState.innerText = "ปกติ (ไม่มีแรงกระทำ)";
                lblState.className = "font-bold text-teal-400";
            } else {
                lblState.innerText = "สภาพยืดหยุ่น (Elastic Deformation)";
                lblState.className = "font-bold text-cyan-400";
            }
        }

        lblStress.innerText = stress.toExponential(3) + ' Pa';
        lblStrain.innerText = strain.toFixed(6);

        // Draw Simulation Frame
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Anchor wall (left)
        ctx.fillStyle = '#334155';
        ctx.fillRect(0, 0, 15, canvas.height);
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 2;
        for (let y = 0; y < canvas.height; y += 12) {
            ctx.beginPath();
            ctx.moveTo(15, y);
            ctx.lineTo(0, y + 10);
            ctx.stroke();
        }

        // Rod parameters
        const startX = 15;
        const baseWidth = 140;
        const wireY = canvas.height / 2;
        const thickness = matKey === 'rubber' ? 5 : (matKey === 'clay' ? 14 : 3);
        const stretchAmount = strain * (matKey === 'rubber' ? 40 : 150); // visual scaling
        const endX = startX + baseWidth + stretchAmount;

        // Draw Rod/Wire
        ctx.strokeStyle = conf.color;
        ctx.lineWidth = thickness;
        ctx.lineCap = 'round';

        if (isFractured) {
            // Snapped wire drawing
            const midX = (startX + endX) / 2;
            ctx.beginPath();
            ctx.moveTo(startX, wireY);
            ctx.lineTo(midX - 10, wireY + 5);
            ctx.moveTo(midX + 10, wireY - 5);
            ctx.lineTo(endX, wireY);
            ctx.stroke();

            // Broken marker
            ctx.fillStyle = '#ef4444';
            ctx.font = '10px monospace';
            ctx.fillText('SNAP!', midX - 12, wireY - 15);
        } else {
            ctx.beginPath();
            ctx.moveTo(startX, wireY);
            ctx.lineTo(endX, wireY);
            ctx.stroke();

            // Tension wave if near elastic limit
            if (currentF > conf.elasticF * 0.8) {
                ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
                ctx.lineWidth = thickness + 2;
                ctx.beginPath();
                ctx.arc(endX, wireY, 8 + Math.sin(Date.now() / 25) * 2, 0, Math.PI * 2);
                ctx.stroke();
            }

            // Hanger and Force Vector (Weight)
            ctx.fillStyle = '#1e293b';
            ctx.fillRect(endX, wireY - 10, 8, 20); // grip

            // Force vector arrow
            if (currentF > 0) {
                const arrowLength = Math.min(60, 15 + currentF / 15);
                ctx.strokeStyle = '#ef4444';
                ctx.lineWidth = 2.5;
                ctx.beginPath();
                ctx.moveTo(endX + 8, wireY);
                ctx.lineTo(endX + 8 + arrowLength, wireY);
                ctx.moveTo(endX + 8 + arrowLength - 6, wireY - 5);
                ctx.lineTo(endX + 8 + arrowLength, wireY);
                ctx.lineTo(endX + 8 + arrowLength - 6, wireY + 5);
                ctx.stroke();

                ctx.fillStyle = '#ef4444';
                ctx.font = '10px sans-serif';
                ctx.fillText('F', endX + arrowLength + 12, wireY + 4);
            }
        }
    };

    slider.oninput = throttle(() => {
        updateOutputs();
    }, 20);

    // Trigger update once on select change
    materialSelect.onchange = () => {
        maxForceApplied = 0;
        slider.value = 0;
        updateOutputs();
    };

    updateOutputs();
}

// ==========================================
// SIMULATOR 2: Young's Modulus Lab (Virtual Lab)
// ==========================================

function initYmSim() {
    stopSimulations();
    const cvSetup = document.getElementById('sim-ym-canvas');
    const cvGraph = document.getElementById('sim-ym-graph-canvas');
    if (!cvSetup || !cvGraph) return;

    const ctxSetup = cvSetup.getContext('2d');
    const ctxGraph = cvGraph.getContext('2d');

    const selectMat = document.getElementById('sim-ym-material');
    const sL0 = document.getElementById('sim-ym-l0-slider');
    const sd = document.getElementById('sim-ym-d-slider');
    const sMass = document.getElementById('sim-ym-mass-slider');

    const lblL0 = document.getElementById('lbl-sim-ym-l0');
    const lbld = document.getElementById('lbl-sim-ym-d');
    const lblMass = document.getElementById('lbl-sim-ym-mass');

    const outArea = document.getElementById('lbl-sim-ym-area-val');
    const outForce = document.getElementById('lbl-sim-ym-force-val');
    const outStress = document.getElementById('lbl-sim-ym-stress-val');
    const outStrain = document.getElementById('lbl-sim-ym-strain-val');
    const outDl = document.getElementById('lbl-sim-ym-dl-val');

    // Constants
    const g = 9.8;
    const Y_values = {
        tungsten: 35e10,
        steel: 20e10,
        copper: 11e10,
        aluminum: 7e10,
        glass: 6e10
    };
    const colors = {
        tungsten: '#2dd4bf',
        steel: '#38bdf8',
        copper: '#fb923c',
        aluminum: '#94a3b8',
        glass: '#a7f3d0'
    };

    const updateLab = () => {
        const mat = selectMat.value;
        const Y = Y_values[mat];
        const L0 = parseFloat(sL0.value);
        const d_mm = parseFloat(sd.value);
        const M = parseFloat(sMass.value);

        lblL0.innerText = L0.toFixed(2) + ' m';
        lbld.innerText = d_mm.toFixed(1) + ' mm';
        lblMass.innerText = M + ' kg';

        // Calculations
        const r_m = (d_mm / 2) / 1000;
        const A = Math.PI * r_m * r_m; // area in m2
        const F = M * g;
        const stress = F / A;
        const strain = stress / Y;
        const dL = strain * L0; // change in length in m

        // UI Outputs
        outArea.innerText = (A * 1e6).toFixed(3) + ' mm²';
        outForce.innerText = F.toFixed(1) + ' N';
        outStress.innerText = stress.toExponential(3) + ' Pa';
        outStrain.innerText = strain.toExponential(4);
        outDl.innerText = (dL * 1000).toFixed(4) + ' mm';

        // --- DRAW SETUP CANVAS ---
        ctxSetup.clearRect(0, 0, cvSetup.width, cvSetup.height);

        // Draw wood frame/track
        ctxSetup.fillStyle = '#78350f';
        ctxSetup.fillRect(10, 30, cvSetup.width - 40, 20); // main track
        ctxSetup.fillRect(10, 50, 15, 80); // peg support
        ctxSetup.fillRect(cvSetup.width - 45, 50, 15, 60); // pulley support

        // Anchor Peg (Left)
        ctxSetup.fillStyle = '#64748b';
        ctxSetup.beginPath();
        ctxSetup.arc(20, 25, 6, 0, Math.PI * 2);
        ctxSetup.fill();

        // Pulley wheel (Right)
        const pX = cvSetup.width - 38;
        const pY = 28;
        const pR = 12;
        ctxSetup.fillStyle = '#475569';
        ctxSetup.beginPath();
        ctxSetup.arc(pX, pY, pR, 0, Math.PI * 2);
        ctxSetup.fill();
        ctxSetup.strokeStyle = '#94a3b8';
        ctxSetup.lineWidth = 2;
        ctxSetup.stroke();

        // Stretched wire drawing
        const wireLengthPixel = cvSetup.width - 58;
        const wireThick = Math.max(1, Math.min(5, d_mm * 2));
        const stretchPixel = dL * 2500; // visual amplification

        ctxSetup.strokeStyle = colors[mat];
        ctxSetup.lineWidth = wireThick;
        ctxSetup.beginPath();
        ctxSetup.moveTo(20, 25);
        ctxSetup.lineTo(pX, pY - pR); // wire on pulley
        ctxSetup.stroke();

        // Hanging hanger string & weight
        ctxSetup.strokeStyle = '#94a3b8';
        ctxSetup.lineWidth = 1;
        ctxSetup.beginPath();
        ctxSetup.moveTo(pX + pR, pY);
        ctxSetup.lineTo(pX + pR, pY + 40 + stretchPixel);
        ctxSetup.stroke();

        // Hanger tray
        ctxSetup.fillStyle = '#334155';
        ctxSetup.fillRect(pX + pR - 15, pY + 40 + stretchPixel, 30, 4); // base tray
        ctxSetup.fillRect(pX + pR - 1, pY + pR, 2, 40 + stretchPixel - pR); // center rod

        // Draw Sandbags (Mass blocks)
        ctxSetup.fillStyle = '#b45309';
        const numBlocks = Math.min(10, Math.ceil(M / 10));
        for (let i = 0; i < numBlocks; i++) {
            ctxSetup.fillRect(pX + pR - 12, pY + 40 + stretchPixel - 5 - (i * 6), 24, 5);
        }

        // --- DRAW GRAPH CANVAS ---
        ctxGraph.clearRect(0, 0, cvGraph.width, cvGraph.height);

        // Drawing margins
        const padX = 40;
        const padY = 30;
        const gW = cvGraph.width - padX - 10;
        const gH = cvGraph.height - padY - 10;

        // Axes
        ctxGraph.strokeStyle = '#cbd5e1';
        ctxGraph.lineWidth = 1.5;
        ctxGraph.beginPath();
        ctxGraph.moveTo(padX, 10);
        ctxGraph.lineTo(padX, cvGraph.height - padY);
        ctxGraph.lineTo(cvGraph.width - 5, cvGraph.height - padY);
        ctxGraph.stroke();

        // Grid lines (y)
        ctxGraph.strokeStyle = '#334155';
        ctxGraph.lineWidth = 0.5;
        ctxGraph.font = '8px monospace';
        ctxGraph.fillStyle = '#94a3b8';
        ctxGraph.textAlign = 'right';

        // 3 Y-ticks representing Stress up to 5 * 10^8
        for (let i = 1; i <= 3; i++) {
            const y = cvGraph.height - padY - (gH / 3) * i;
            ctxGraph.beginPath();
            ctxGraph.moveTo(padX - 3, y);
            ctxGraph.lineTo(cvGraph.width - 5, y);
            ctxGraph.stroke();
            ctxGraph.fillText((i * 1.5).toFixed(1) + 'e8', padX - 5, y + 3);
        }

        // X-ticks representing Strain up to 2 * 10^-3
        ctxGraph.textAlign = 'center';
        for (let i = 1; i <= 3; i++) {
            const x = padX + (gW / 3) * i;
            ctxGraph.beginPath();
            ctxGraph.moveTo(x, cvGraph.height - padY);
            ctxGraph.lineTo(x, cvGraph.height - padY + 3);
            ctxGraph.stroke();
            ctxGraph.fillText((i * 0.5).toFixed(1) + 'e-3', x, cvGraph.height - padY + 12);
        }

        // Labels
        ctxGraph.fillStyle = '#cbd5e1';
        ctxGraph.font = '8px sans-serif';
        ctxGraph.fillText('Strain (ε)', cvGraph.width - 30, cvGraph.height - 15);
        ctxGraph.save();
        ctxGraph.translate(12, 50);
        ctxGraph.rotate(-Math.PI / 2);
        ctxGraph.fillText('Stress (σ)', 0, 0);
        ctxGraph.restore();

        // Draw Slope Line
        // Max x-range = 2e-3, Max y-range = 4.5e8
        const getPixelX = (strn) => padX + (strn / 2e-3) * gW;
        const getPixelY = (strs) => cvGraph.height - padY - (strs / 4.5e8) * gH;

        // Line based on Y
        const startLineX = 0;
        const endLineX = 2e-3;
        const endLineY = endLineX * Y;

        ctxGraph.strokeStyle = '#475569';
        ctxGraph.lineWidth = 1;
        ctxGraph.beginPath();
        ctxGraph.moveTo(getPixelX(startLineX), getPixelY(0));
        ctxGraph.lineTo(getPixelX(endLineX), getPixelY(endLineY));
        ctxGraph.stroke();

        // Plot current point
        if (M > 0) {
            const ptX = getPixelX(strain);
            const ptY = getPixelY(stress);

            ctxGraph.fillStyle = colors[mat];
            ctxGraph.beginPath();
            ctxGraph.arc(ptX, ptY, 5, 0, Math.PI * 2);
            ctxGraph.fill();
        }
    };

    [selectMat, sL0, sd, sMass].forEach(el => {
        el.oninput = updateLab;
    });

    updateLab();
}

// ==========================================
// DYNAMIC QUESTION TEMPLATES (17.1 Elasticity)
// ==========================================

const QUESTION_TEMPLATES = [
    // 17.1.2 ความเค้นตามยาว (Stress)
    {
        id: '17_1_1_stress_simple', topic: '17.1.1', type: 'numeric_single',
        title: 'หาความเค้นตามยาวของเส้นลวด',
        inputs: [{ label: 'ความเค้นตามยาว \\( (\\text{N/m}^2) \\):' }],
        text: (p) => `ลวดโลหะเส้นหนึ่งมีพื้นที่หน้าตัด \\( ${p.area} \\times 10^{-6} \\text{ m}^2 \\) ถูกดึงด้วยแรงขนาด \\( ${p.r ? `(${p.f_base} + \\ ${p.r})` : p.f} \\text{ N} \\) ในแนวดิ่งตามแนวยาวของเส้นลวด จงหาความเค้นตามยาวในเส้นลวดมีค่ากี่นิวตันต่อตารางเมตร`,
        generate: (r) => {
            const offset = getOffsetFromR(r);
            const area = r ? getSeededRandomBase('17_1_1_stress_simple_a', r, 1.2, 2.8, 0.2) : 2.0; // 1.2 - 2.8 mm²
            const f_base = r ? getSeededRandomBase('17_1_1_stress_simple_f', r, 300, 600, 50) : 400;
            const f = r ? f_base + offset : 400;
            
            const area_m2 = area * 1e-6;
            const stress = f / area_m2;

            return {
                params: { area, f, f_base, r: offset },
                answers: [`\\( ${formatScientificLaTeX(stress, 2)} \\)`, `\\( ${formatScientificLaTeX(stress, 3)} \\)`, stress.toExponential(2).replace('e+', 'x10^'), stress.toExponential(3).replace('e+', 'x10^'), Math.round(stress).toString(), stress.toFixed(0)],
                answersRaw: [stress],
                explanation: () => `
      จากสูตรการคำนวณความเค้นตามยาว: \\( \\sigma = \\frac{F}{A} \\)<br>
      - แรงดึง \\( F = ${r ? `(${f_base} + \\ ${offset})` : f} \\text{ N} \\)<br>
      - พื้นที่หน้าตัด \\( A = ${area} \\times 10^{-6} \\text{ m}^2 \\)<br>
      แทนค่าในสูตร:<br>
      \\( \\sigma = \\frac{${f}}{${area} \\times 10^{-6}} = ${formatScientificLaTeX(stress, 3)} \\text{ N/m}^2 \\) (หรือ พาสคัล)
    `
            };
        }
    },
    {
        id: '17_1_1_stress_sq_bar', topic: '17.1.1', type: 'numeric_single',
        title: 'ความเค้นของแท่งวัสดุหน้าตัดสี่เหลี่ยม',
        inputs: [{ label: 'ความเค้นตามยาว \\( (\\text{N/m}^2) \\):' }],
        text: (p) => `แท่งเสาคอนกรีตหน้าตัดสี่เหลี่ยมจัตุรัสที่มีขนาดด้านละ \\( ${p.side} \\text{ cm} \\) รองรับน้ำหนักจากแรงกดทับกดลงมาแนวตั้งฉากมีขนาด \\( ${p.r ? `(${p.f_base} + \\ ${p.r})` : p.f} \\text{ kN} \\) จงหาความเค้นกดทับในเสาคอนกรีตนี้ในหน่วยนิวตันต่อตารางเมตร`,
        generate: (r) => {
            const offset = getOffsetFromR(r);
            const side = r ? getSeededRandomBase('17_1_1_stress_sq_side', r, 10, 30, 5) : 20; // 10, 15, 20, 25, 30 cm
            const f_base = r ? getSeededRandomBase('17_1_1_stress_sq_f', r, 40, 80, 5) : 50; // kN
            const f = r ? f_base + offset : 50;

            const A = (side / 100) * (side / 100); // cm2 to m2
            const F_N = f * 1000; // kN to N
            const stress = F_N / A;

            return {
                params: { side, f, f_base, r: offset },
                answers: [`\\( ${formatScientificLaTeX(stress, 2)} \\)`, stress.toExponential(2).replace('e+', 'x10^'), Math.round(stress).toString(), stress.toFixed(0)],
                answersRaw: [stress],
                explanation: () => `
      - แรงดึง/กด \\( F = ${f} \\text{ kN} = ${F_N} \\text{ N} \\)<br>
      - พื้นที่หน้าตัดสี่เหลี่ยมจัตุรัส: \\( A = \\text{ด้าน} \\times \\text{ด้าน} = ${side/100} \\text{ m} \\times ${side/100} \\text{ m} = ${A} \\text{ m}^2 \\)<br>
      จากสูตร: \\( \\sigma = \\frac{F}{A} \\)<br>
      \\( \\sigma = \\frac{${F_N}}{${A}} = ${formatScientificLaTeX(stress, 3)} \\text{ N/m}^2 \\)
    `
            };
        }
    },

    // 17.1.2 ความเครียดตามยาว (Strain)
    {
        id: '17_1_2_strain_simple', topic: '17.1.2', type: 'numeric_single',
        title: 'ความเครียดตามยาวของเส้นลวด',
        inputs: [{ label: 'ความเครียดตามยาว:' }],
        text: (p) => `ลวดเหล็กกล้าเส้นหนึ่งมีความยาวเริ่มต้น \\( ${p.l0} \\text{ m} \\) แขวนมวลถ่วงน้ำหนักจนลวดยืดออกยาวขึ้นจากเดิม \\( ${p.r ? `(${p.dl_base} + \\ ${p.r})` : p.dl} \\text{ mm} \\) จงหาความเครียดตามยาวที่เกิดขึ้นในเส้นลวดนี้`,
        generate: (r) => {
            const offset = getOffsetFromR(r);
            const l0 = r ? getSeededRandomBase('17_1_2_strain_l0', r, 1.5, 4.0, 0.5) : 2.5; // 1.5 - 4.0 m
            const dl_base = r ? getSeededRandomBase('17_1_2_strain_dl', r, 2.0, 5.0, 0.5) : 3.0; // mm
            const dl = r ? dl_base + offset : 3.0;

            const dl_m = dl / 1000; // mm to m
            const strain = dl_m / l0;

            return {
                params: { l0, dl, dl_base, r: offset },
                answers: [strain.toFixed(6), `\\( ${formatScientificLaTeX(strain, 2)} \\)`, `\\( ${formatScientificLaTeX(strain, 3)} \\)`, strain.toExponential(2).replace('e-', 'x10^-'), strain.toExponential(3).replace('e-', 'x10^-')],
                answersRaw: [strain],
                explanation: () => `
      จากสูตรความเครียดตามยาว: \\( \\varepsilon = \\frac{\\Delta L}{L_0} \\)<br>
      - ความยาวที่เปลี่ยนไป \\( \\Delta L = ${dl} \\text{ mm} = ${dl_m} \\text{ m} \\)<br>
      - ความยาวเดิม \\( L_0 = ${l0} \\text{ m} \\)<br>
      แทนค่าในสูตร:<br>
      \\( \\varepsilon = \\frac{${dl_m}}{${l0}} = ${formatScientificLaTeX(strain, 6)} \\) (หรือ \\( ${formatScientificLaTeX(strain, 3, true)} \\))
    `
            };
        }
    },
    {
        id: '17_1_2_strain_percent', topic: '17.1.2', type: 'numeric_single',
        title: 'คำนวณร้อยละการยืดตัวของสายเคเบิล',
        inputs: [{ label: 'ความเครียดตามยาว:' }],
        text: (p) => `สายเคเบิลลิฟต์เส้นหนึ่งยืดตัวออกยาวเพิ่มขึ้นร้อยละ \\( ${p.r ? `(${p.pct_base} + \\ ${p.r * 0.05})` : p.pct} \\) ของความยาวเดิมเมื่อรับน้ำหนักผู้โดยสารเต็มพิกัด จงหาความเครียดตามยาวของสายเคเบิลนี้`,
        generate: (r) => {
            const offset = getOffsetFromR(r);
            const pct_base = r ? getSeededRandomBase('17_1_2_strain_pct', r, 0.1, 0.4, 0.05) : 0.2;
            const pct = r ? pct_base + offset * 0.05 : 0.2;

            const strain = pct / 100;

            return {
                params: { pct: parseFloat(pct.toFixed(2)), pct_base, r: offset },
                answers: [strain.toFixed(5), `\\( ${formatScientificLaTeX(strain, 2)} \\)`, `\\( ${formatScientificLaTeX(strain, 3)} \\)`, strain.toExponential(2).replace('e-', 'x10^-')],
                answersRaw: [strain],
                explanation: () => `
      - การยืดออกร้อยละ \\( ${pct.toFixed(2)}\\% \\) หมายความว่า อัตราส่วนของความยาวที่ยืดขึ้นต่อความยาวเดิมคือ:<br>
      \\( \\frac{\\Delta L}{L_0} = \\frac{${pct.toFixed(2)}}{100} \\)<br>
      ดังนั้น ความเครียดตามยาว: \\( \\varepsilon = \\frac{${pct.toFixed(2)}}{100} = ${formatScientificLaTeX(strain, 5)} \\) (หรือ \\( ${formatScientificLaTeX(strain, 3, true)} \\))
    `
            };
        }
    },

    // 17.1.3 มอดุลัสของยัง (Young's Modulus)
    {
        id: '17_1_3_ym_steel_wire', topic: '17.1.3', type: 'numeric_single',
        title: 'หามอดุลัสของยังของสายกีตาร์',
        inputs: [{ label: 'มอดุลัสของยัง \\( (\\text{N/m}^2) \\):' }],
        text: (p) => `ลวดสายกีตาร์ยาวเริ่มต้น \\( ${p.l0} \\text{ m} \\) มีพื้นที่หน้าตัด \\( ${p.area} \\times 10^{-6} \\text{ m}^2 \\) เมื่อดึงสายนี้ด้วยแรงขนาด \\( ${p.r ? `(${p.f_base} + \\ ${p.r})` : p.f} \\text{ N} \\) ปรากฏว่าสายยาวเพิ่มขึ้นจากเดิม \\( ${p.dl} \\text{ mm} \\) จงหาค่ามอดุลัสของยังของวัสดุที่ใช้ทำสายกีตาร์นี้`,
        generate: (r) => {
            const offset = getOffsetFromR(r);
            const l0 = r ? getSeededRandomBase('17_1_3_ym_steel_l0', r, 1.0, 2.0, 0.2) : 1.2;
            const area = r ? getSeededRandomBase('17_1_3_ym_steel_a', r, 0.4, 0.8, 0.1) : 0.5; // mm2
            const f_base = r ? getSeededRandomBase('17_1_3_ym_steel_f', r, 100, 200, 10) : 150;
            const f = r ? f_base + offset : 150;
            const dl = r ? getSeededRandomBase('17_1_3_ym_steel_dl', r, 1.2, 2.4, 0.2) : 1.8; // mm

            const A_m2 = area * 1e-6;
            const dl_m = dl / 1000;
            const Y = (f * l0) / (A_m2 * dl_m);

            return {
                params: { l0, area, f, f_base, dl, r: offset },
                answers: [`\\( ${formatScientificLaTeX(Y, 2)} \\)`, `\\( ${formatScientificLaTeX(Y, 3)} \\)`, Y.toExponential(2).replace('e+', 'x10^'), Y.toExponential(3).replace('e+', 'x10^')],
                answersRaw: [Y],
                explanation: () => `
      จากสูตรความสัมพันธ์มอดุลัสของยัง: \\( Y = \\frac{\\sigma}{\\varepsilon} = \\frac{F L_0}{A \\Delta L} \\)<br>
      - ความยาวเดิม \\( L_0 = ${l0} \\text{ m} \\)<br>
      - พื้นที่หน้าตัด \\( A = ${area} \\times 10^{-6} \\text{ m}^2 \\)<br>
      - แรงดึง \\( F = ${f} \\text{ N} \\)<br>
      - ระยะยืด \\( \\Delta L = ${dl} \\text{ mm} = ${dl * 1e-3} \\text{ m} \\)<br>
      แทนค่า:<br>
      \\( Y = \\frac{(${f})(${l0})}{(${area} \\times 10^{-6})(${dl * 1e-3})} = ${formatScientificLaTeX(Y, 3)} \\text{ N/m}^2 \\)
    `
            };
        }
    },
    {
        id: '17_1_3_ym_find_elong', topic: '17.1.3', type: 'numeric_single',
        title: 'หาระยะยืดของลวดเหล็กกล้า',
        inputs: [{ label: 'ระยะยืดออกของลวด (cm):' }],
        text: (p) => `ลวดเหล็กกล้ามีความยาว \\( ${p.l0} \\text{ m} \\) มีพื้นที่หน้าตัด \\( ${p.area} \\text{ cm}^2 \\) แขวนวัตถุมวล \\( ${p.r ? `(${p.m_base} + \\ ${p.r * 10})` : p.m} \\text{ kg} \\) ไว้ในแนวดิ่ง จงหาว่าลวดจะยืดออกจากเดิมกี่เซนติเมตร (กำหนดให้ มอดุลัสของยังเหล็กกล้า \\( Y = 2.0 \\times 10^{11} \\text{ N/m}^2 \\) และเร่งโน้มถ่วง \\( g = 9.8 \\text{ m/s}^2 \\))`,
        generate: (r) => {
            const offset = getOffsetFromR(r);
            const l0 = r ? getSeededRandomBase('17_1_3_ym_find_elong_l0', r, 2.0, 5.0, 0.5) : 4.0;
            const area = r ? getSeededRandomBase('17_1_3_ym_find_elong_a', r, 0.4, 1.0, 0.2) : 0.8; // cm2
            const m_base = r ? getSeededRandomBase('17_1_3_ym_find_elong_m', r, 4000, 8000, 500) : 7000;
            const m = r ? m_base + offset * 10 : 7000;

            const F = m * g;
            const A_m2 = area * 1e-4; // cm2 to m2
            const Y = 2.0e11;
            const dl_m = (F * l0) / (A_m2 * Y);
            const dl_cm = dl_m * 100; // to cm

            return {
                params: { l0, area, m, m_base, r: offset },
                answers: [dl_cm.toFixed(2), dl_cm.toFixed(3), dl_cm.toFixed(1)],
                answersRaw: [dl_cm],
                explanation: () => `
      จากสูตร: \\( Y = \\frac{F L_0}{A \\Delta L} \\Rightarrow \\Delta L = \\frac{F L_0}{A Y} \\)<br>
      - แรงดึง \\( F = mg = ${m} \\times 9.8 = ${F.toFixed(0)} \\text{ N} \\)<br>
      - พื้นที่หน้าตัด \\( A = ${area} \\text{ cm}^2 = ${area} \\times 10^{-4} \\text{ m}^2 \\)<br>
      - มอดุลัสของยัง \\( Y = 2.0 \\times 10^{11} \\text{ N/m}^2 \\)<br>
      แทนค่าหาหน่วยเมตร:<br>
      \\( \\Delta L = \\frac{(${F.toFixed(0)})(${l0})}{(${area} \\times 10^{-4})(2.0 \\times 10^{11})} = ${formatScientificLaTeX(dl_m, 4)} \\text{ m} \\)<br>
      แปลงเป็นเซนติเมตร: \\( \\Delta L = ${dl_cm.toFixed(3)} \\text{ cm} \\)
    `
            };
        }
    },

    // 17.1.4 ขีดความปลอดภัย (Safety Limit)
    {
        id: '17_1_4_safety_max_mass', topic: '17.1.4', type: 'numeric_single',
        title: 'คำนวณหามวลสูงสุดที่ไม่ทำให้ลวดสูญเสียสภาพยืดหยุ่น',
        inputs: [{ label: 'มวลสูงสุด (kg):' }],
        text: (p) => `ลวดโลหะชนิดหนึ่งมีขีดจำกัดสภาพยืดหยุ่นเกิดขึ้นที่ความเค้น \\( ${p.elastic_stress} \\times 10^8 \\text{ Pa} \\) ถ้าลวดเส้นนี้มีขนาดเส้นผ่านศูนย์กลาง \\( ${p.r ? `(${p.d_base} + \\ ${p.r * 0.1})` : p.d} \\text{ mm} \\) จะสามารถนำมาแขวนมวลวัตถุสูงสุดได้กี่กิโลกรัมโดยที่ลวดยังสามารถคืนสภาพความยาวเดิมได้อยู่ (กำหนดให้ \\( g = 9.8 \\text{ m/s}^2 \\))`,
        generate: (r) => {
            const offset = getOffsetFromR(r);
            const elastic_stress = r ? getSeededRandomBase('17_1_4_safety_max_mass_s', r, 1.5, 3.5, 0.5) : 2.5; // * 10^8
            const d_base = r ? getSeededRandomBase('17_1_4_safety_max_mass_d', r, 1.0, 2.0, 0.2) : 1.2;
            const d = r ? d_base + offset * 0.1 : 1.2;

            const r_m = (d / 2) / 1000;
            const A = Math.PI * r_m * r_m;
            const F_max = (elastic_stress * 1e8) * A;
            const m_max = F_max / g;

            return {
                params: { elastic_stress, d: parseFloat(d.toFixed(2)), d_base, r: offset },
                answers: [m_max.toFixed(1), m_max.toFixed(0), m_max.toFixed(2)],
                answersRaw: [m_max],
                explanation: () => `
      ขีดจำกัดสภาพยืดหยุ่นบ่งบอกความเค้นสูงสุดที่จะไม่ทำให้วัสดุเกิดการเสียรูปถาวร:<br>
      \\( \\sigma_{\\text{max}} = \\frac{F_{\\text{max}}}{A} \\Rightarrow F_{\\text{max}} = \\sigma_{\\text{max}} \\times A \\)<br>
      - พื้นที่หน้าตัดวงกลม \\( A = \\pi r^2 = \\pi \\left(\\frac{${d.toFixed(2)} \\times 10^{-3}}{2}\\right)^2 = ${formatScientificLaTeX(A, 4)} \\text{ m}^2 \\)<br>
      - แรงดึงสูงสุด: \\( F_{\\text{max}} = (${elastic_stress} \\times 10^8) \\times ${formatScientificLaTeX(A, 4)} = ${F_max.toFixed(1)} \\text{ N} \\)<br>
      - หามวลสูงสุด: \\( M_{\\text{max}} = \\frac{F_{\\text{max}}}{g} = \\frac{${F_max.toFixed(1)}}{9.8} = ${m_max.toFixed(1)} \\text{ kg} \\)
    `
            };
        }
    },

    // 17.1.5 โจทย์ผสมและเปรียบเทียบอัตราส่วน (Ratios & Concepts)
    {
        id: '17_1_5_ratio_length', topic: '17.1.5', type: 'numeric_single',
        title: 'เปรียบเทียบระยะยืดของวัสดุชนิดเดียวกัน',
        inputs: [{ label: 'อัตราส่วนระยะยืดลวดเส้นแรกต่อเส้นที่สอง:' }],
        text: (p) => `ลวดสองเส้นทำด้วยโลหะชนิดเดียวกัน ลวดเส้นแรกยาว \\( L \\) และมีพื้นที่หน้าตัดเป็น \\( ${p.r ? `(${p.a_base} + \\ ${p.r})` : p.area_ratio} \\) เท่าของลวดเส้นที่สอง หากลวดเส้นที่สองยาว \\( 2L \\) เมื่อนำแรงดึงที่มีขนาดเท่ากันมาดึงลวดทั้งสองเส้น จงหาว่าลวดเส้นแรกจะยืดออกเป็นกี่เท่าของลวดเส้นที่สอง`,
        generate: (r) => {
            const offset = getOffsetFromR(r);
            const a_base = r ? getSeededRandomBase('17_1_5_ratio_length_a', r, 2, 5, 1) : 3;
            const area_ratio = r ? a_base + offset : 3;

            // dL = FL / AY
            // dL1 / dL2 = (L1/L2) * (A2/A1) * (Y2/Y1)
            // Y1 = Y2 (same material)
            // L1 = L, L2 = 2L => L1/L2 = 1/2
            // A1 = area_ratio * A2 => A2/A1 = 1/area_ratio
            // dL1 / dL2 = (1/2) * (1/area_ratio) = 1 / (2 * area_ratio)
            const result = 1 / (2 * area_ratio);

            return {
                params: { area_ratio, a_base, r: offset },
                answers: [result.toFixed(3), result.toFixed(4), (1 / (2 * area_ratio)).toString()],
                answersRaw: [result],
                explanation: () => `
      จากสมการการยืดของลวด: \\( \\Delta L = \\frac{F L_0}{A Y} \\)<br>
      เขียนอัตราส่วนของลวดเส้นที่ 1 ต่อเส้นที่ 2 (แรงดึงและวัสดุเดียวกัน ทำให้ \\( F \\) และ \\( Y \\) หักล้างกัน):<br>
      \\( \\frac{\\Delta L_1}{\\Delta L_2} = \\left( \\frac{L_1}{L_2} \\right) \\times \\left( \\frac{A_2}{A_1} \\right) \\)<br>
      แทนค่าความสัมพันธ์:<br>
      - \\( L_1 = L \\) และ \\( L_2 = 2L \\Rightarrow \\frac{L_1}{L_2} = \\frac{1}{2} \\)<br>
      - \\( A_1 = ${area_ratio} A_2 \\Rightarrow \\frac{A_2}{A_1} = \\frac{1}{${area_ratio}} \\)<br>
      คำนวณอัตราส่วน:<br>
      \\( \\frac{\\Delta L_1}{\\Delta L_2} = \\frac{1}{2} \\times \\frac{1}{${area_ratio}} = \\frac{1}{${2 * area_ratio}} \\approx ${result.toFixed(4)} \\) เท่า
    `
            };
        }
    },
    {
        id: '17_1_5_concept_elasticity', topic: '17.1.5', type: 'choice',
        title: 'แนวคิดสำคัญเรื่องสมบัติสภาพยืดหยุ่น',
        choices: [
            'วัตถุจะสามารถหดกลับคืนรูปร่างเดิมได้เสมอเมื่อหยุดออกแรง ไม่ว่าจะออกแรงมากเท่าใด',
            'สภาพพลาสติกเป็นสมบัติเฉพาะตัวที่เกิดขึ้นได้กับวัสดุประเภทกลุ่มพลาสติกเท่านั้น',
            'ขีดจำกัดสภาพยืดหยุ่นระบุถึงความเค้นสูงสุดที่วัสดุยังสามารถหดกลับสู่รูปร่างและขนาดเดิมได้เมื่อหยุดดึง',
            'มอดุลัสของยังระบุถึงความแข็งแรงในการรับแรงดึงจนกว่าวัสดุจะฉีกขาดออกจากกันที่จุดแตกหัก'
        ],
        text: () => `เมื่อพิจารณาพฤติกรรมเชิงกลของของแข็งตามหลักวิทยาศาสตร์ ข้อความใดกล่าวได้ถูกต้องตามหลักฟิสิกส์ที่สุด`,
        generate: (r) => ({
            params: {},
            answers: ['ขีดจำกัดสภาพยืดหยุ่นระบุถึงความเค้นสูงสุดที่วัสดุยังสามารถหดกลับสู่รูปร่างและขนาดเดิมได้เมื่อหยุดดึง'],
            answersRaw: [2],
            explanation: () => `
      - **ข้อ 1 ผิด:** หากออกแรงดึงเกินขีดจำกัดสภาพยืดหยุ่น วัตถุจะเกิดการบิดเบี้ยวถาวรและไม่คืนรูปเดิม<br>
      - **ข้อ 2 ผิด:** สภาพพลาสติกหมายถึงคุณสมบัติทางกลของวัสดุอื่นๆ เช่น เหล็ก ดินน้ำมัน หรืออลูมิเนียมเมื่อเสียรูปถาวร ไม่ได้เจาะจงเฉพาะกลุ่มเม็ดพลาสติก<br>
      - **ข้อ 3 ถูก:** ขีดจำกัดสภาพยืดหยุ่น (Elastic Limit) คือความเค้นสูงสุดที่จะไม่ทำให้เกิดการยืดตัวแบบพลาสติกหรือยืดถาวร<br>
      - **ข้อ 4 ผิด:** มอดุลัสของยังบอกถึงความยากง่ายในการยืดตัวของวัสดุ (ความชันในช่วงแปรผันตรง) ไม่ใช่จุดแตกร้าวหรือความทนทานต่อแรงดึงสูงสุด
    `
        })
    }
];

// Dynamically generate other intermediate questions to populate the 21 questions bank
for (let i = 1; i <= 13; i++) {
    // Generate simple variations for other subtopics
    if (i % 3 === 1) {
        QUESTION_TEMPLATES.push({
            id: `17_1_1_generated_stress_var_${i}`, topic: '17.1.1', type: 'numeric_single',
            title: `การวิเคราะห์ความเค้นตามยาว (ชุดที่ ${i})`,
            inputs: [{ label: 'ความเค้นตามยาว (Pa):' }],
            text: (p) => `ลวดเหล็กกล้ามีเส้นผ่านศูนย์กลางหน้าตัดเป็นวงกลมขนาด \\( ${p.dia} \\text{ mm} \\) ถูกดึงด้วยน้ำหนักมวล \\( ${p.r ? `(${p.m_base} + \\ ${p.r * 5})` : p.m} \\text{ kg} \\) แขวนไว้ในแนวดิ่ง จงหาความเค้นตามยาวในเส้นลวดนี้ในหน่วยพาสคัล (กำหนดให้ \\( g = 9.8 \\text{ m/s}^2 \\))`,
            generate: (r) => {
                const offset = getOffsetFromR(r);
                const dia = r ? getSeededRandomBase(`17_1_1_gen_d_${i}`, r, 0.8, 1.8, 0.2) : 1.0;
                const m_base = r ? getSeededRandomBase(`17_1_1_gen_m_${i}`, r, 50, 200, 10) : 100;
                const m = r ? m_base + offset * 5 : 100;

                const F = m * g;
                const area = Math.PI * Math.pow((dia / 2) / 1000, 2);
                const stress = F / area;

                return {
                    params: { dia, m, m_base, r: offset },
                    answers: [`\\( ${formatScientificLaTeX(stress, 2)} \\)`, `\\( ${formatScientificLaTeX(stress, 3)} \\)`, stress.toExponential(2).replace('e+', 'x10^'), stress.toExponential(3).replace('e+', 'x10^'), Math.round(stress).toString(), stress.toFixed(0)],
                    answersRaw: [stress],
                    explanation: () => `
          คำนวณจากสูตร: \\( \\sigma = \\frac{F}{A} \\)<br>
          - แรงดึง \\( F = mg = ${m} \\times 9.8 = ${F.toFixed(1)} \\text{ N} \\)<br>
          - พื้นที่หน้าตัด \\( A = \\pi r^2 = \\pi \\left(\\frac{${dia} \\times 10^{-3}}{2}\\right)^2 = ${formatScientificLaTeX(area, 4)} \\text{ m}^2 \\)<br>
          แทนค่า:<br>
          \\( \\sigma = \\frac{${F.toFixed(1)}}{${formatScientificLaTeX(area, 4)}} = ${formatScientificLaTeX(stress, 3)} \\text{ Pa} \\)
        `
                };
            }
        });
    } else if (i % 3 === 2) {
        QUESTION_TEMPLATES.push({
            id: `17_1_2_generated_strain_var_${i}`, topic: '17.1.2', type: 'numeric_single',
            title: `การวิเคราะห์ความเครียดตามยาว (ชุดที่ ${i})`,
            inputs: [{ label: 'ความเครียดตามยาว:' }],
            text: (p) => `เสาคอนกรีตสูง \\( ${p.l0} \\text{ m} \\) ย่นหดตัวลงไปจากเดิม \\( ${p.r ? `(${p.dl_base} + \\ ${p.r * 0.05})` : p.dl} \\text{ mm} \\) เมื่อมีแรงกดทับอย่างหนักจากด้านบน จงหาขนาดของความเครียดตามยาวในเสาต้นนี้`,
            generate: (r) => {
                const offset = getOffsetFromR(r);
                const l0 = r ? getSeededRandomBase(`17_1_2_gen_l0_${i}`, r, 3.0, 6.0, 0.5) : 4.0;
                const dl_base = r ? getSeededRandomBase(`17_1_2_gen_dl_${i}`, r, 0.4, 1.2, 0.1) : 0.8;
                const dl = r ? dl_base + offset * 0.05 : 0.8;

                const dl_m = dl / 1000;
                const strain = dl_m / l0;

                return {
                    params: { l0, dl: parseFloat(dl.toFixed(2)), dl_base, r: offset },
                    answers: [strain.toFixed(6), `\\( ${formatScientificLaTeX(strain, 2)} \\)`, `\\( ${formatScientificLaTeX(strain, 3)} \\)`, strain.toExponential(2).replace('e-', 'x10^-')],
                    answersRaw: [strain],
                    explanation: () => `
          จากสูตรความเครียดตามยาว: \\( \\varepsilon = \\frac{\\Delta L}{L_0} \\)<br>
          - ความยาวหดตัวลง \\( \\Delta L = ${dl.toFixed(2)} \\text{ mm} = ${dl_m} \\text{ m} \\)<br>
          - ความยาวเดิม \\( L_0 = ${l0} \\text{ m} \\)<br>
          แทนค่า:<br>
          \\( \\varepsilon = \\frac{${dl_m}}{${l0}} = ${formatScientificLaTeX(strain, 3)} \\)
        `
                };
            }
        });
    } else {
        QUESTION_TEMPLATES.push({
            id: `17_1_3_generated_ym_var_${i}`, topic: '17.1.3', type: 'numeric_single',
            title: `การวิเคราะห์มอดุลัสของยัง (ชุดที่ ${i})`,
            inputs: [{ label: 'ระยะยืดของวัสดุ (mm):' }],
            text: (p) => `ลวดทองแดงมีมอดุลัสของยัง \\( 1.1 \\times 10^{11} \\text{ Pa} \\) และยาวเริ่มต้น \\( ${p.l0} \\text{ m} \\) มีพื้นที่หน้าตัด \\( ${p.area} \\times 10^{-6} \\text{ m}^2 \\) เมื่อนำแรงดึงขนาด \\( ${p.r ? `(${p.f_base} + \\ ${p.r})` : p.f} \\text{ N} \\) มาดึงในแนวดิ่ง จงหาว่าลวดทองแดงนี้จะยืดออกกี่มิลลิเมตร`,
            generate: (r) => {
                const offset = getOffsetFromR(r);
                const l0 = r ? getSeededRandomBase(`17_1_3_gen_l0_${i}`, r, 1.5, 3.0, 0.5) : 2.0;
                const area = r ? getSeededRandomBase(`17_1_3_gen_a_${i}`, r, 0.5, 1.5, 0.2) : 1.0;
                const f_base = r ? getSeededRandomBase(`17_1_3_gen_f_${i}`, r, 200, 400, 20) : 300;
                const f = r ? f_base + offset : 300;

                const Y = 1.1e11;
                const A_m2 = area * 1e-6;
                const dl_m = (f * l0) / (A_m2 * Y);
                const dl_mm = dl_m * 1000;

                return {
                    params: { l0, area, f, f_base, r: offset },
                    answers: [dl_mm.toFixed(3), dl_mm.toFixed(2), dl_mm.toFixed(4)],
                    answersRaw: [dl_mm],
                    explanation: () => `
          จากสูตรมอดุลัสของยัง: \\( Y = \\frac{F L_0}{A \\Delta L} \\Rightarrow \\Delta L = \\frac{F L_0}{A Y} \\)<br>
          แทนค่าเพื่อหาระยะยืดในหน่วยเมตร:<br>
          \\( \\Delta L = \\frac{(${f})(${l0})}{(${area} \\times 10^{-6})(1.1 \\times 10^{11})} = ${formatScientificLaTeX(dl_m, 4)} \\text{ m} \\)<br>
          แปลงเป็นมิลลิเมตร (คูณด้วย 1000): \\( \\Delta L = ${dl_mm.toFixed(3)} \\text{ mm} \\)
        `
                };
            }
        });
    }
}

// Add extra variations to round up exactly 21 questions of different topics
QUESTION_TEMPLATES.push(
    {
        id: '17_1_4_safety_factor', topic: '17.1.4', type: 'numeric_single',
        title: 'หาขนาดความเค้นปลอดภัยในการใช้งานเสาเข็ม',
        inputs: [{ label: 'ความเค้นที่ปลอดภัยสูงสุด (Pa):' }],
        text: (p) => `เสาหินมีค่าขีดจำกัดการทนความเค้นสูงสุดก่อนที่มันจะแตกร้าวหรือชำรุดเสียหายที่ \\( ${p.max_stress} \\times 10^7 \\text{ Pa} \\) ถ้าวิศวกรออกแบบระบบก่อสร้างเสานี้โดยกำหนดค่าตัวคูณความปลอดภัย (Safety Factor) เท่ากับ \\( ${p.r ? `(${p.sf_base} + \\ ${p.r * 0.1})` : p.sf} \\) จงหาขีดจำกัดของความเค้นดึงสูงสุดที่ปลอดภัยต่อการใช้งานในหน่วยพาสคัล`,
        generate: (r) => {
            const offset = getOffsetFromR(r);
            const max_stress = r ? getSeededRandomBase('17_1_4_safety_fac_ms', r, 6, 12, 1) : 8; // * 10^7
            const sf_base = r ? getSeededRandomBase('17_1_4_safety_fac_sf', r, 2.0, 4.0, 0.5) : 2.5;
            const sf = r ? sf_base + offset * 0.1 : 2.5;

            const safe_stress = (max_stress * 1e7) / sf;

            return {
                params: { max_stress, sf: parseFloat(sf.toFixed(2)), sf_base, r: offset },
                answers: [`\\( ${formatScientificLaTeX(safe_stress, 2)} \\)`, safe_stress.toExponential(2).replace('e+', 'x10^'), Math.round(safe_stress).toString(), safe_stress.toFixed(0)],
                answersRaw: [safe_stress],
                explanation: () => `
      ความสัมพันธ์ของการออกแบบความเค้นดึงที่ปลอดภัยคือ:<br>
      \\( \\sigma_{\\text{safe}} = \\frac{\\sigma_{\\text{ultimate}}}{\\text{Safety Factor}} \\)<br>
      แทนค่า:<br>
      \\( \\sigma_{\\text{safe}} = \\frac{${max_stress} \\times 10^7}{${sf.toFixed(2)}} = ${formatScientificLaTeX(safe_stress, 3)} \\text{ Pa} \\)
    `
            };
        }
    },
    {
        id: '17_1_5_ratio_composite', topic: '17.1.5', type: 'numeric_single',
        title: 'อัตราส่วนระยะยืดของวัสดุต่างประเภทภายใต้แรงดึง',
        inputs: [{ label: 'อัตราส่วนระยะยืดลวด X ต่อลวด Y:' }],
        text: (p) => `ลวดเหล็กกล้า X มีมอดุลัสของยังเป็น \\( 2.0 \\times 10^{11} \\text{ Pa} \\) และลวดทองแดง Y มีมอดุลัสของยังเป็น \\( 1.1 \\times 10^{11} \\text{ Pa} \\) ถ้าลวดทั้งสองมีความยาวเริ่มต้นและพื้นที่หน้าตัดเท่ากัน เมื่อดึงด้วยแรงเท่ากัน จงหาอัตราส่วนของระยะยืดลวด X ต่อระยะยืดลวด Y`,
        generate: (r) => {
            const Yx = 2.0e11;
            const Yy = 1.1e11;
            // dLx / dLy = Yy / Yx (inversely proportional)
            const ratio = Yy / Yx; // 1.1 / 2.0 = 0.55

            return {
                params: {},
                answers: [ratio.toFixed(2), ratio.toFixed(3), '0.55'],
                answersRaw: [ratio],
                explanation: () => `
      ระยะยืดของวัสดุมีความสัมพันธ์แบบผกผันกับมอดุลัสของยัง: \\( \\Delta L \\propto \\frac{1}{Y} \\) (เมื่อแรง ความยาว และพื้นที่หน้าตัดเท่ากัน)<br>
      ดังนั้น อัตราส่วนระยะยืดของลวด X ต่อลวด Y คือ:<br>
      \\( \\frac{\\Delta L_X}{\\Delta L_Y} = \\frac{Y_Y}{Y_X} = \\frac{1.1 \\times 10^{11} \\text{ Pa}}{2.0 \\times 10^{11} \\text{ Pa}} = 0.55 \\) เท่า
    `
            };
        }
    }
);

// Final Question Templates count check
const finalCount = QUESTION_TEMPLATES.length;

// --- Practice Engine ---
function startPracticeMode(topic) {
    currentPracticeTopic = topic;
    document.getElementById('practice-arena').classList.remove('hidden');
    ['17-1-1', '17-1-2', '17-1-3', '17-1-4', '17-1-5'].forEach(t => {
        const btn = document.getElementById(`btn-prac-${t}`);
        if (btn) btn.className = t === topic
            ? "p-4 bg-slate-100 border-2 border-cyan-500 text-slate-900 rounded-xl flex items-center gap-4 transition text-left shadow-sm"
            : "p-4 bg-white hover:bg-slate-50 text-slate-800 rounded-xl border border-slate-200 flex items-center gap-4 transition text-left shadow-sm hover:shadow";
    });
    document.getElementById('prac-feedback').classList.add('hidden');
    document.getElementById('prac-explanation-box').classList.add('hidden');
    regeneratePractice();
}

function regeneratePractice() {
    const mode = document.getElementById('prac-type-select').value;
    const isRandom = mode === 'random';

    const formattedTopic = currentPracticeTopic.replace('17-1-', '17.1.');
    const filtered = QUESTION_TEMPLATES.filter(q => q.topic === formattedTopic);

    if (!filtered.length) return;

    if (!practiceHistory[formattedTopic]) {
        practiceHistory[formattedTopic] = [];
    }

    let available = filtered.filter(q => !practiceHistory[formattedTopic].includes(q.id));

    if (available.length === 0) {
        const lastShown = practiceHistory[formattedTopic][practiceHistory[formattedTopic].length - 1];
        practiceHistory[formattedTopic] = lastShown ? [lastShown] : [];
        available = filtered.filter(q => !practiceHistory[formattedTopic].includes(q.id));
    }

    if (available.length === 0) {
        available = filtered;
    }

    const template = available[Math.floor(Math.random() * available.length)];
    practiceHistory[formattedTopic].push(template.id);

    if (practiceHistory[formattedTopic].length > Math.max(1, filtered.length - 1)) {
        practiceHistory[formattedTopic].shift();
    }

    let instance = null;
    let attempts = 0;
    const history = getHistory();

    while (attempts < 100) {
        attempts++;
        let R;
        if (isRandom) {
            R = Math.floor(Math.random() * 1000000) + 1;
        } else {
            R = "standard_" + Math.floor(Math.random() * 1000000);
        }
        
        instance = template.generate(R);
        
        const vals = getActiveParamValues(instance.params);
        if (vals.length > 0) {
            if (hasDuplicateVariables(instance.params)) {
                continue;
            }
            const key = generateUniqueKey(template.id, instance.params);
            if (history.includes(key)) {
                continue;
            }
            addToHistory(key);
        }
        break;
    }

    currentPracticeQuestion = { template, instance };
    document.getElementById('prac-badge-mode').innerText = `หมวดหมู่โจทย์: ${template.topic.replace('-calc', '').replace('-concept', '')} • ${isRandom ? 'โหมดสุ่มตัวเลข' : 'โจทย์ปกติ'}`;
    document.getElementById('prac-question-title').innerText = `📋 โจทย์: ${template.title}`;
    document.getElementById('prac-question-text').innerHTML = template.text(instance.params);

    const cz = document.getElementById('prac-choice-zone'), nz = document.getElementById('prac-numeric-zone');
    document.getElementById('prac-input-val1').value = '';
    document.getElementById('prac-input-val2').value = '';
    document.getElementById('prac-input-zone-2').classList.add('hidden');
    document.getElementById('prac-feedback').classList.add('hidden');
    document.getElementById('prac-explanation-box').classList.add('hidden');

    if (template.type === 'choice') {
        cz.classList.remove('hidden'); nz.classList.add('hidden');
        cz.innerHTML = template.choices.map(c => `<button onclick="checkPracticeChoice('${c}')" class="w-full text-left px-5 py-3 bg-white hover:bg-cyan-50 text-slate-800 font-medium rounded-xl border border-slate-200 hover:border-cyan-300 transition">${c}</button>`).join('');
    } else {
        cz.classList.add('hidden'); nz.classList.remove('hidden');
        document.getElementById('lbl-prac-input-1').innerHTML = template.inputs[0].label;
        if (template.type === 'numeric_double') {
            document.getElementById('prac-input-zone-2').classList.remove('hidden');
            document.getElementById('lbl-prac-input-2').innerHTML = template.inputs[1].label;
        }
    }
    queueTypeset(document.getElementById('practice-arena'));
}

function checkPracticeAnswer() {
    if (!currentPracticeQuestion) return;
    const { template, instance } = currentPracticeQuestion;
    if (template.type === 'choice') return;

    const v1 = document.getElementById('prac-input-val1').value.trim();
    const v2 = document.getElementById('prac-input-val2').value.trim();

    if (!v1 || (template.type === 'numeric_double' && !v2)) {
        triggerAlert("กรอกข้อมูลไม่ครบ", "ระบุคำตอบให้ครบก่อนกดตรวจเฉลยครับ", "fa-circle-question", "bg-cyan-100 text-cyan-600");
        return;
    }

    const c1 = isNumericAnswerCorrect(v1, instance.answersRaw[0]);
    const c2 = template.type === 'numeric_double' ? isNumericAnswerCorrect(v2, instance.answersRaw[1]) : true;
    showPracticeFeedback(c1 && c2, instance.explanation());
}

function checkPracticeChoice(choice) {
    if (!currentPracticeQuestion) return;
    const { instance } = currentPracticeQuestion;
    showPracticeFeedback(choice === instance.answers[0], instance.explanation());
}

function showPracticeFeedback(isCorrect, explainText) {
    const fb = document.getElementById('prac-feedback');
    fb.className = `p-5 rounded-2xl border block ${isCorrect ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-800'}`;
    fb.innerHTML = isCorrect
        ? `<div class="font-bold flex items-center gap-2"><i class="fa-solid fa-circle-check text-emerald-500 text-lg"></i> ยอดเยี่ยม! คำตอบของคุณถูกต้องครบถ้วน</div>`
        : `<div class="font-bold flex items-center gap-2"><i class="fa-solid fa-circle-xmark text-red-500 text-lg"></i> คำตอบไม่ตรงเฉลย ศึกษาขั้นตอนด้านล่างกันครับ</div>`;
    document.getElementById('prac-explanation-text').innerHTML = explainText;
    document.getElementById('prac-explanation-box').classList.remove('hidden');
    queueTypeset(document.getElementById('practice-arena'));
}

// --- Exam Engine ---
function startExamProcess() {
    const name = document.getElementById('exam-student-name').value.trim();
    const cls = document.getElementById('exam-student-class').value;
    const num = document.getElementById('exam-student-no').value.trim();
    const R_parsed = parseInt(num);
    if (!name || !cls || isNaN(R_parsed) || R_parsed < 1 || R_parsed > 40) {
        triggerAlert("ข้อมูลไม่ครบถ้วน", "กรุณาระบุ ชื่อ ชั้นเรียน และเลขที่ (1-40) ให้ถูกต้องก่อนเริ่มสอบครับ", "fa-user", "bg-cyan-100 text-cyan-600");
        return;
    }

    const timestamp = Date.now();
    examSeed = `${num}_${timestamp}`;
    examDurationSeconds = 15 * 60; // 15 mins
    examStudentInfo = { name, class: cls, number: num, seed: examSeed };

    const pureShuffle = (array) => {
        const arr = [...array];
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    };

    // Filter questions by subtopics:
    const q_Stress = QUESTION_TEMPLATES.filter(q => q.topic === '17.1.1');
    const q_Strain = QUESTION_TEMPLATES.filter(q => q.topic === '17.1.2');
    const q_Ym = QUESTION_TEMPLATES.filter(q => q.topic === '17.1.3');
    const q_Safety = QUESTION_TEMPLATES.filter(q => q.topic === '17.1.4');
    const q_Ratio = QUESTION_TEMPLATES.filter(q => q.topic === '17.1.5');

    const shuffled_Stress = pureShuffle(q_Stress);
    const shuffled_Strain = pureShuffle(q_Strain);
    const shuffled_Ym = pureShuffle(q_Ym);
    const shuffled_Safety = pureShuffle(q_Safety);
    const shuffled_Ratio = pureShuffle(q_Ratio);

    // Build unique 5-question layout covering all subtopics
    let selectedTemplates = [
        shuffled_Stress[0],
        shuffled_Strain[0],
        shuffled_Ym[0],
        shuffled_Safety[0],
        shuffled_Ratio[0]
    ];

    selectedTemplates = pureShuffle(selectedTemplates);

    currentExamQuestions = selectedTemplates.map((template, index) => {
        let instance = null;
        let attempts = 0;
        const history = getHistory();
        
        while (attempts < 100) {
            attempts++;
            const seed = `${num}_${timestamp}_${template.id}_${attempts}`;
            instance = template.generate(seed);
            
            const vals = getActiveParamValues(instance.params);
            if (vals.length > 0) {
                if (hasDuplicateVariables(instance.params)) {
                    continue;
                }
                const key = generateUniqueKey(template.id, instance.params);
                if (history.includes(key)) {
                    continue;
                }
                addToHistory(key);
            }
            break;
        }

        const choices = template.type === 'choice' ? pureShuffle(template.choices) : [];
        return {
            id: template.id, topic: template.topic, type: template.type, title: template.title,
            text: template.text(instance.params), inputs: template.inputs || [], choices: choices,
            answers: instance.answers,
            answersRaw: instance.answersRaw,
            explanationText: instance.explanation()
        };
    });

    document.getElementById('lbl-exam-user-info').innerHTML = `${name} (ม.6/${cls} เลขที่ ${num})`;

    renderExamLiveDOM();

    examStartTimestamp = Date.now();
    examDeadlineTimestamp = examStartTimestamp + (examDurationSeconds * 1000);
    examTimeRemaining = examDurationSeconds;
    examIsActive = true;
    examSubmissionInProgress = false;

    sessionStorage.setItem(EXAM_STATE_KEY, JSON.stringify({
        examQuestions: currentExamQuestions, studentInfo: examStudentInfo, examStartTimestamp, examDeadlineTimestamp, examDurationSeconds
    }));

    setupExamLocks();
    showSection('exam-live');
    startExamTimer();
}

function setupExamLocks() {
    examExitGuardEnabled = true;
    document.body.classList.add('exam-locked');
    window.addEventListener('beforeunload', handleExamBeforeUnload);
}
function releaseExamLocks() {
    examExitGuardEnabled = false;
    document.body.classList.remove('exam-locked');
    window.removeEventListener('beforeunload', handleExamBeforeUnload);
}
function handleExamBeforeUnload(e) { if (examIsActive) { e.preventDefault(); e.returnValue = ''; } }

function renderExamLiveDOM() {
    const container = document.getElementById('exam-questions-container');
    container.innerHTML = '';
    currentExamQuestions.forEach((q, idx) => {
        let inputHTML = '';
        if (q.type === 'choice') {
            inputHTML += `<div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">`;
            q.choices.forEach((c, cIdx) => {
                inputHTML += `<label class="flex items-center gap-3 bg-slate-50 border border-slate-200 hover:bg-slate-100 p-4 rounded-xl cursor-pointer transition">
              <input type="radio" name="exam-q${idx}" value="${c}" class="w-4 h-4 text-cyan-600 focus:ring-cyan-500">
              <span class="text-sm text-slate-800">${c}</span>
            </label>`;
            });
            inputHTML += `</div>`;
        } else if (q.type === 'numeric_single') {
            inputHTML += `<div class="mt-4"><label class="block text-xs font-bold text-slate-500 mb-1">${q.inputs[0].label}</label>
            <input type="text" id="exam-q${idx}-val1" class="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-cyan-500 outline-none font-mono text-sm"></div>`;
        } else if (q.type === 'numeric_double') {
            inputHTML += `<div class="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-bold text-slate-500 mb-1">${q.inputs[0].label}</label>
              <input type="text" id="exam-q${idx}-val1" class="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-cyan-500 outline-none font-mono text-sm">
            </div>
            <div>
              <label class="block text-xs font-bold text-slate-500 mb-1">${q.inputs[1].label}</label>
              <input type="text" id="exam-q${idx}-val2" class="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-cyan-500 outline-none font-mono text-sm">
            </div>
          </div>`;
        }
        container.innerHTML += `<div class="bg-white rounded-2xl p-6 md:p-8 shadow-sm border border-slate-200">
          <div class="flex items-center justify-between border-b border-slate-100 pb-3 mb-4">
            <span class="font-bold text-slate-800">ข้อที่ ${idx + 1}: ${q.title}</span>
            <span class="bg-cyan-100 text-cyan-800 px-2.5 py-1 rounded-md text-xs font-bold">2 คะแนน</span>
          </div>
          <p class="text-sm md:text-base text-slate-700 leading-relaxed font-medium math-font">${q.text}</p>
          ${inputHTML}
        </div>`;
    });
    queueTypeset(container);
}

function startExamTimer() {
    clearInterval(examTimerInterval);
    examTimerInterval = setInterval(() => {
        if (!examIsActive) return;
        examTimeRemaining = Math.max(0, Math.ceil((examDeadlineTimestamp - Date.now()) / 1000));
        document.getElementById('exam-timer-display').innerText = formatExamTime(examTimeRemaining);
        if (examTimeRemaining < 60) document.getElementById('exam-timer-display').classList.add('text-red-400');

        if (examTimeRemaining <= 0) {
            clearInterval(examTimerInterval);
            triggerAlert("หมดเวลาการสอบ", "ระบบได้ส่งผลข้อสอบของท่านอัตโนมัติเรียบร้อยแล้ว", "fa-clock", "bg-red-100 text-red-600");
            submitExam(true);
        }
    }, 500);
}

function getExamAnswers() {
    return currentExamQuestions.map((q, idx) => {
        if (q.type === 'choice') {
            const chk = document.querySelector(`input[name="exam-q${idx}"]:checked`);
            return chk ? chk.value : null;
        } else if (q.type === 'numeric_single') {
            return [document.getElementById(`exam-q${idx}-val1`).value];
        } else if (q.type === 'numeric_double') {
            return [
                document.getElementById(`exam-q${idx}-val1`).value,
                document.getElementById(`exam-q${idx}-val2`).value
            ];
        }
        return null;
    });
}

function confirmSubmitExam() {
    const answers = getExamAnswers();
    const uncomplete = answers.some(a => !a || (Array.isArray(a) && (a.some(val => !val.trim()))));
    const msg = uncomplete ? "คุณยังกรอกข้อสอบไม่ครบถ้วน ยืนยันต้องการส่งข้อสอบทันทีเลยหรือไม่?" : "คุณกรอกข้อสอบเรียบร้อยครบทุกข้อ ยืนยันความถูกต้องและต้องการส่งเลยหรือไม่?";

    const m = document.getElementById('modal-confirm');
    const c = document.getElementById('modal-confirm-card');
    document.getElementById('modal-confirm-msg').innerText = msg;

    m.classList.remove('hidden');
    setTimeout(() => { c.classList.remove('scale-95', 'opacity-0'); }, 10);
}

function closeConfirmModal() {
    const m = document.getElementById('modal-confirm');
    const c = document.getElementById('modal-confirm-card');
    c.classList.add('scale-95', 'opacity-0');
    setTimeout(() => { m.classList.add('hidden'); }, 200);
}

function executeSubmitExam() {
    closeConfirmModal();
    setTimeout(() => submitExam(), 200);
}

function submitExam(timeExpired = false) {
    if (examSubmissionInProgress) return;
    examSubmissionInProgress = true;
    examIsActive = false;
    clearInterval(examTimerInterval);
    releaseExamLocks();

    const answers = getExamAnswers();
    let total_score = 0;
    const gradedResults = [];

    currentExamQuestions.forEach((q, idx) => {
        const userAns = answers[idx];

        let isCorrect = false;
        if (q.type === 'choice') {
            isCorrect = userAns === q.answers[0];
        } else if (q.type === 'numeric_single') {
            isCorrect = userAns && isNumericAnswerCorrect(userAns[0], q.answersRaw[0]);
        } else if (q.type === 'numeric_double') {
            isCorrect = userAns &&
                isNumericAnswerCorrect(userAns[0], q.answersRaw[0]) &&
                isNumericAnswerCorrect(userAns[1], q.answersRaw[1]);
        }

        const score = isCorrect ? 2.0 : 0.0;
        total_score += score;
        gradedResults.push({
            idx, isCorrect, score, userAns,
            expectedAnswers: q.answers,
            explanationText: q.explanationText
        });
    });

    const elapsed = timeExpired ? examDurationSeconds : (examDurationSeconds - examTimeRemaining);
    const timeStr = `${Math.floor(elapsed / 60)} นาที ${elapsed % 60} วินาที`;

    const payload = {
        score: total_score, timeTaken: timeStr, studentInfo: examStudentInfo,
        gradedResults, examQuestions: currentExamQuestions, date: new Date().toLocaleDateString('th-TH')
    };
    localStorage.setItem('last_exam_results_17_1', JSON.stringify(payload));
    sessionStorage.removeItem(EXAM_STATE_KEY);

    updateLatestScore();
    showSection('exam-result');
    renderExamResults(payload);
}

function renderExamResults(data) {
    document.getElementById('lbl-res-student-name').innerText = data.studentInfo.name;
    document.getElementById('lbl-res-student-meta').innerHTML = `(ม.6/${data.studentInfo.class} เลขที่ ${data.studentInfo.number})`;
    document.getElementById('lbl-res-time-elapsed').innerText = data.timeTaken;
    document.getElementById('lbl-res-finished-at').innerText = data.date;

    document.getElementById('lbl-res-total-score').innerText = data.score;
    const circle = document.getElementById('res-circle-progress');
    circle.style.strokeDashoffset = 439.8 - (data.score / 10) * 439.8;

    const fb = document.getElementById('lbl-res-badge-feedback');
    if (data.score >= 8) fb.innerHTML = `<span class="text-emerald-600 font-bold"><i class="fa-solid fa-star"></i> ยอดเยี่ยม! คุณเข้าใจทฤษฎีและสูตรคำนวณสภาพยืดหยุ่นได้เป็นอย่างดี</span>`;
    else if (data.score >= 5) fb.innerHTML = `<span class="text-cyan-600 font-bold"><i class="fa-solid fa-thumbs-up"></i> ดี! ผ่านเกณฑ์ความเข้าใจระดับหนึ่ง ลองตรวจสอบความถูกต้องของหน่วยและการแปลงความยาวดูนะครับ</span>`;
    else fb.innerHTML = `<span class="text-red-600 font-bold"><i class="fa-solid fa-book"></i> ยังไม่ผ่านเกณฑ์ แนะนำให้ทบทวนสูตรความเค้นความเครียด มอดุลัส และการยืดตัวถาวรเพิ่มเติม</span>`;

    const tbody = document.getElementById('exam-result-tbody');
    const sols = document.getElementById('exam-solutions-container');
    tbody.innerHTML = ''; sols.innerHTML = '';

    data.gradedResults.forEach((grad, i) => {
        const q = data.examQuestions[i];
        const status = grad.isCorrect
            ? `<span class="text-emerald-500 font-bold"><i class="fa-solid fa-check"></i> 2.0</span>`
            : `<span class="text-red-500 font-bold"><i class="fa-solid fa-xmark"></i> 0.0</span>`;

        tbody.innerHTML += `<tr class="bg-white">
          <td class="px-5 py-3 font-medium text-center">${i + 1}</td>
          <td class="px-5 py-3 text-slate-700">${q.title}</td>
          <td class="px-5 py-3 text-center">2.0</td>
          <td class="px-5 py-3 text-center">${status}</td>
        </tr>`;

        let uAns = 'ไม่ได้ระบุคำตอบ';
        if (q.type === 'choice') uAns = grad.userAns || uAns;
        else if (grad.userAns && grad.userAns[0]) uAns = grad.userAns[0] + (q.type === 'numeric_double' ? ` และ ${grad.userAns[1]}` : '');

        sols.innerHTML += `<div class="bg-white p-5 rounded-xl border border-slate-200">
          <h5 class="font-bold text-slate-800 mb-2">ข้อ ${i + 1}: ${q.title}</h5>
          <p class="text-sm text-slate-600 mb-3 math-font">${q.text}</p>
          <div class="text-xs bg-slate-50 p-3 rounded-lg border border-slate-100 mb-3 font-mono">
            <p>คำตอบของคุณ: <span class="font-bold ${grad.isCorrect ? 'text-emerald-600' : 'text-red-600'}">${uAns}</span></p>
            <p>เฉลยที่ถูกต้อง: <span class="font-bold text-slate-800">${grad.expectedAnswers.join(' หรือ ')}</span></p>
          </div>
          <div class="text-xs text-slate-700 bg-cyan-50/50 p-3 rounded-lg math-font border border-cyan-100">${grad.explanationText}</div>
        </div>`;
    });
    queueTypeset(document.getElementById('sec-exam-result'));
}

function toggleExamSolutionBox() {
    const box = document.getElementById('exam-solution-box');
    const icon = document.getElementById('icon-toggle-sol');
    box.classList.toggle('hidden');
    icon.className = box.classList.contains('hidden') ? "fa-solid fa-chevron-down" : "fa-solid fa-chevron-up";
}

function updateLatestScore() {
    if (typeof window === 'undefined') return;
    try {
        const saved = localStorage.getItem('last_exam_results_17_1');
        const badge = document.getElementById('latest-score-badge');
        if (saved && badge) {
            const data = JSON.parse(saved);
            const scoreLbl = document.getElementById('lbl-last-score');
            if (scoreLbl) {
                scoreLbl.innerHTML = `${data.score}/10 \\( (\\text{${data.studentInfo.name}}) \\)`;
                badge.classList.remove('hidden');
                queueTypeset(scoreLbl);
            }
        }
    } catch (e) {
        console.error('Failed to update latest score badge', e);
    }
}

function showLatestResultModal() {
    if (typeof window === 'undefined') return;
    try {
        const saved = localStorage.getItem('last_exam_results_17_1');
        if (saved) {
            showSection('exam-result');
            renderExamResults(JSON.parse(saved));
        }
    } catch (e) {
        console.error('Failed to show latest result modal', e);
    }
}

// --- On Load Init ---
window.onload = () => {
    updateLatestScore();
    switchReviewTab('17-1-1');
    queueTypeset(document.body);

    const activeSession = sessionStorage.getItem(EXAM_STATE_KEY);
    if (activeSession) {
        try {
            const s = JSON.parse(activeSession);
            if (s.examDeadlineTimestamp > Date.now()) {
                currentExamQuestions = s.examQuestions;
                examStudentInfo = s.studentInfo;
                examSeed = s.studentInfo.seed || null;
                examDeadlineTimestamp = s.examDeadlineTimestamp;
                examDurationSeconds = s.examDurationSeconds;
                examIsActive = true;
                document.getElementById('lbl-exam-user-info').innerHTML = `${s.studentInfo.name} (ม.6/${s.studentInfo.class} เลขที่ ${s.studentInfo.number})`;
                renderExamLiveDOM();
                setupExamLocks();
                showSection('exam-live');
                startExamTimer();
            } else {
                sessionStorage.removeItem(EXAM_STATE_KEY);
            }
        } catch (e) { sessionStorage.removeItem(EXAM_STATE_KEY); }
    }

    const totalQuestions = QUESTION_TEMPLATES.length;
    document.getElementById('total-count').innerText = totalQuestions;
};
