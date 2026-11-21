const canvas = document.getElementById("scope");
const ctx = canvas.getContext("2d");
const readout = document.getElementById("readout");
const signalBar = document.getElementById("signalBar");
const freqSlider = document.getElementById("freqSlider");
const freqVal = document.getElementById("freqVal");
const gateSlider = document.getElementById("gate");
const gateVal = document.getElementById("gateVal");
const speedSlider = document.getElementById("speedSlider");
const speedVal = document.getElementById("speedVal");
const startBtn = document.getElementById("startBtn");
const recalBtn = document.getElementById("recalBtn");

const CX = canvas.width / 2;
const CY = canvas.height / 2;
const MAX_R = 200;

let audioCtx = null;
let osc = null;
let sampleRate = 48000;
const CARRIER_HZ = 17500;
const fftSize = 2048;
let motionEnergy = 0;
let peakSpeedHz = 0;
let bestRecordHz = 0;
let holdFrames = 0;
let running = false;
let calCount = 0;
let lowerBaseline = new Float32Array(128);
let upperBaseline = new Float32Array(128);
let lastTriggerTime = 0;

function triggerSpeedBeep() {
  const nowMs = performance.now();
  if (nowMs - lastTriggerTime < 220) {
    return;
  }
  lastTriggerTime = nowMs;

  const toneHz = Number(freqSlider.value);

  // Plays beep at your chosen Tone Hz whenever speed exceeds Min Speed
  if (audioCtx && toneHz > 0) {
    const now = audioCtx.currentTime;
    const beepOsc = audioCtx.createOscillator();
    const beepGain = audioCtx.createGain();

    beepOsc.type = "sine";
    beepOsc.frequency.setValueAtTime(toneHz, now);

    beepGain.gain.setValueAtTime(0.001, now);
    beepGain.gain.linearRampToValueAtTime(1.0, now + 0.01);
    beepGain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);

    beepOsc.connect(beepGain);
    beepGain.connect(audioCtx.destination);
    beepOsc.start(now);
    beepOsc.stop(now + 0.16);
  }

  // Optional vibration on Android phones or paired Bluetooth gamepads
  if (navigator.vibrate) {
    navigator.vibrate(110);
  }
  if (navigator.getGamepads) {
    const gamepads = navigator.getGamepads();
    for (let g = 0; g < gamepads.length; g++) {
      const pad = gamepads.at(g);
      if (pad && pad.vibrationActuator) {
        pad.vibrationActuator.playEffect("dual-rumble", {
          startDelay: 0,
          duration: 120,
          weakMagnitude: 0.8,
          strongMagnitude: 1.0
        });
      }
    }
  }
}

function resetCalibration() {
  calCount = 0;
  lowerBaseline.fill(0);
  upperBaseline.fill(0);
  motionEnergy = 0;
  bestRecordHz = 0;
  holdFrames = 0;
  if (running) {
    readout.textContent = "CALIBRATING - HOLD STILL (1 SEC)...";
    readout.style.color = "#ffd166";
  }
}

recalBtn.addEventListener("click", resetCalibration);

freqSlider.addEventListener("input", function () {
  freqVal.textContent = freqSlider.value;
});

gateSlider.addEventListener("input", function () {
  gateVal.textContent = gateSlider.value;
});

speedSlider.addEventListener("input", function () {
  speedVal.textContent = speedSlider.value;
});

function drawScope() {
  ctx.fillStyle = "rgba(2, 10, 5, 0.24)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "rgba(0, 255, 102, 0.22)";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    ctx.beginPath();
    ctx.arc(CX, CY, (MAX_R / 4) * i, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.moveTo(CX - MAX_R, CY);
  ctx.lineTo(CX + MAX_R, CY);
  ctx.moveTo(CX, CY - MAX_R);
  ctx.lineTo(CX, CY + MAX_R);
  ctx.stroke();

  if (running && (motionEnergy > 0.08 || holdFrames > 0)) {
    const displayEnergy = Math.max(motionEnergy, holdFrames > 0 ? 0.55 : 0);
    const pulseR = 30 + displayEnergy * (MAX_R - 30);

    ctx.beginPath();
    ctx.arc(CX, CY, pulseR, 0, Math.PI * 2);
    ctx.strokeStyle = "#00ff66";
    ctx.lineWidth = 4 + displayEnergy * 6;
    ctx.stroke();

    ctx.fillStyle = "rgba(0, 255, 102, 0.22)";
    ctx.fill();

    ctx.fillStyle = "#00ff66";
    ctx.font = "bold 18px monospace";
    ctx.textAlign = "center";
    ctx.fillText("SPEED LIMIT EXCEEDED", CX, CY - 28);

    ctx.font = "bold 14px monospace";
    ctx.fillText(peakSpeedHz + " HZ SHIFT", CX, CY + 36);
  }

  ctx.beginPath();
  ctx.arc(CX, CY, 6, 0, Math.PI * 2);
  ctx.fillStyle = "#00ff66";
  ctx.fill();

  requestAnimationFrame(drawScope);
}
drawScope();

startBtn.addEventListener("click", async function () {
  if (running) {
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextClass();

    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }

    sampleRate = audioCtx.sampleRate || 48000;

    osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(CARRIER_HZ, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.9, audioCtx.currentTime + 0.15);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(0);

    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = fftSize;
    analyser.smoothingTimeConstant = 0.08;

    const mic = audioCtx.createMediaStreamSource(stream);
    mic.connect(analyser);

    const freqData = new Uint8Array(analyser.frequencyBinCount);
    const binHz = sampleRate / fftSize;
    const spanBins = Math.min(120, Math.round(650 / binHz));

    lowerBaseline = new Float32Array(spanBins + 1);
    upperBaseline = new Float32Array(spanBins + 1);
    calCount = 0;
    running = true;
    startBtn.textContent = "Active";
    readout.textContent = "CALIBRATING - HOLD STILL (1 SEC)...";

    function update() {
      analyser.getByteFrequencyData(freqData);
      const gate = Number(gateSlider.value);
      const minSpeedHz = Number(speedSlider.value);
      const centerBin = Math.round(CARRIER_HZ / binHz);

      const carrierStrength = freqData.at(centerBin) || 0;
      if (carrierStrength > 130) {
        signalBar.textContent = "MIC CARRIER: STRONG (" + carrierStrength + "/255) | PEAK: " + bestRecordHz + " HZ";
        signalBar.style.color = "#00ff66";
      } else {
        signalBar.textContent = "MIC CARRIER: WEAK (" + carrierStrength + "/255) - RAISE VOLUME";
        signalBar.style.color = "#ff5252";
      }

      if (calCount < 35) {
        for (let i = 1; i <= spanBins; i++) {
          const lowVal = centerBin - i >= 0 ? (freqData.at(centerBin - i) || 0) : 0;
          const upVal = centerBin + i < freqData.length ? (freqData.at(centerBin + i) || 0) : 0;
          lowerBaseline.set(Array.of((lowerBaseline.at(i) || 0) + lowVal / 35), i);
          upperBaseline.set(Array.of((upperBaseline.at(i) || 0) + upVal / 35), i);
        }
        calCount++;
        if (calCount === 35) {
          readout.textContent = "ACTIVE - WATCHING FOR MOTION > " + minSpeedHz + " HZ";
          readout.style.color = "#66ff99";
        }
        requestAnimationFrame(update);
        return;
      }

      let strongestSpike = 0;
      let hitSpeedHz = 0;

      for (let i = 1; i <= spanBins; i++) {
        const shiftHz = i * binHz;
        if (shiftHz < minSpeedHz) {
          continue;
        }

        const currentLower = centerBin - i >= 0 ? (freqData.at(centerBin - i) || 0) : 0;
        const baseLow = lowerBaseline.at(i) || 0;
        const diffLow = Math.max(0, currentLower - baseLow);

        if (diffLow > strongestSpike) {
          strongestSpike = diffLow;
          hitSpeedHz = shiftHz;
        }

        const currentUpper = centerBin + i < freqData.length ? (freqData.at(centerBin + i) || 0) : 0;
        const baseUp = upperBaseline.at(i) || 0;
        const diffUp = Math.max(0, currentUpper - baseUp);

        if (diffUp > strongestSpike) {
          strongestSpike = diffUp;
          hitSpeedHz = shiftHz;
        }
      }

      const netSpike = Math.max(0, strongestSpike - gate);
      const targetEnergy = Math.min(1, netSpike / 45);

      if (targetEnergy > 0.08) {
        motionEnergy = Math.max(motionEnergy, targetEnergy);
        peakSpeedHz = Math.round(hitSpeedHz);
        if (peakSpeedHz > bestRecordHz) {
          bestRecordHz = peakSpeedHz;
        }
        // Beeps on ANY movement faster than Min Speed (both closer and away)
        if (holdFrames === 0) {
          triggerSpeedBeep();
        }
        holdFrames = 20;
      } else {
        motionEnergy *= 0.84;
        if (holdFrames > 0) {
          holdFrames--;
        }
      }

      if (holdFrames > 0) {
        readout.textContent = "SPEED LIMIT EXCEEDED: " + peakSpeedHz + " HZ (~" + Math.round(peakSpeedHz * 0.044) + " MPH)";
        readout.style.color = "#00ff66";
      } else {
        readout.textContent = "MONITORING - LIMIT: " + minSpeedHz + " HZ";
        readout.style.color = "#66ff99";
      }

      requestAnimationFrame(update);
    }

    update();
  } catch (err) {
    readout.textContent = "ERROR: " + err.message;
  }
});
