const canvas = document.getElementById("scope");
const ctx = canvas.getContext("2d");
const readout = document.getElementById("readout");
const gateSlider = document.getElementById("gate");
const startBtn = document.getElementById("startBtn");

const CX = canvas.width / 2;
const CY = canvas.height / 2;
const MAX_R = 200;

let motionEnergy = 0;
let isMovingCloser = true;
let running = false;

function drawScope() {
  ctx.fillStyle = "rgba(2, 10, 5, 0.22)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Concentric range rings
  ctx.strokeStyle = "rgba(0, 255, 102, 0.22)";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    ctx.beginPath();
    ctx.arc(CX, CY, (MAX_R / 4) * i, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Crosshairs
  ctx.beginPath();
  ctx.moveTo(CX - MAX_R, CY);
  ctx.lineTo(CX + MAX_R, CY);
  ctx.moveTo(CX, CY - MAX_R);
  ctx.lineTo(CX, CY + MAX_R);
  ctx.stroke();

  // Centered expanding ring for Moving Closer (green) or Moving Away (cyan)
  if (running && motionEnergy > 0.08) {
    const pulseR = 25 + motionEnergy * (MAX_R - 25);
    const strokeColor = isMovingCloser ? "#00ff66" : "#00ccff";
    const fillColor = isMovingCloser ? "rgba(0, 255, 102, 0.16)" : "rgba(0, 204, 255, 0.16)";
    const labelText = isMovingCloser ? "MOVING CLOSER" : "MOVING AWAY";

    ctx.beginPath();
    ctx.arc(CX, CY, pulseR, 0, Math.PI * 2);
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 3 + motionEnergy * 5;
    ctx.stroke();

    ctx.fillStyle = fillColor;
    ctx.fill();

    ctx.fillStyle = strokeColor;
    ctx.font = "bold 18px monospace";
    ctx.textAlign = "center";
    ctx.fillText(labelText, CX, CY - 24);
  }

  // Center emitter dot
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
    const audioCtx = new AudioContextClass();
    const sampleRate = audioCtx.sampleRate || 48000;
    const CARRIER_HZ = 18500;

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(CARRIER_HZ, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.75, audioCtx.currentTime);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();

    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 16384;
    analyser.smoothingTimeConstant = 0.25;

    const mic = audioCtx.createMediaStreamSource(stream);
    mic.connect(analyser);

    const freqData = new Uint8Array(analyser.frequencyBinCount);
    const binHz = sampleRate / analyser.fftSize;
    const centerBin = Math.round(CARRIER_HZ / binHz);
    const spanBins = Math.round(140 / binHz);

    const lowerBaseline = new Float32Array(spanBins + 1);
    const upperBaseline = new Float32Array(spanBins + 1);
    let calCount = 0;
    running = true;
    readout.textContent = "CALIBRATING - STAY STILL (3 SEC)";

    function update() {
      analyser.getByteFrequencyData(freqData);
      const gate = Number(gateSlider.value);

      if (calCount < 90) {
        for (let i = 1; i <= spanBins; i++) {
          const lowVal = freqData.at(centerBin - i) || 0;
          const upVal = freqData.at(centerBin + i) || 0;
          lowerBaseline.set(Array.of((lowerBaseline.at(i) || 0) + lowVal / 90), i);
          upperBaseline.set(Array.of((upperBaseline.at(i) || 0) + upVal / 90), i);
        }
        calCount++;
        if (calCount === 90) {
          readout.textContent = "ACTIVE - WATCHING FOR MOVEMENT";
        }
        requestAnimationFrame(update);
        return;
      }

      let lowerEnergy = 0;
      let upperEnergy = 0;

      for (let i = 1; i <= spanBins; i++) {
        if (i * binHz < 12) {
          continue;
        }

        const currentLower = freqData.at(centerBin - i) || 0;
        const baseLow = lowerBaseline.at(i) || 0;
        lowerEnergy += Math.max(0, currentLower - baseLow);
        lowerBaseline.set(Array.of(baseLow * 0.992 + currentLower * 0.008), i);

        const currentUpper = freqData.at(centerBin + i) || 0;
        const baseUp = upperBaseline.at(i) || 0;
        upperEnergy += Math.max(0, currentUpper - baseUp);
        upperBaseline.set(Array.of(baseUp * 0.992 + currentUpper * 0.008), i);
      }

      const dominantEnergy = Math.max(upperEnergy, lowerEnergy);
      const netShift = Math.max(0, dominantEnergy - gate);
      const targetEnergy = Math.min(1, netShift / (gate * 3));

      motionEnergy = motionEnergy * 0.72 + targetEnergy * 0.28;

      if (motionEnergy > 0.08) {
        isMovingCloser = upperEnergy >= lowerEnergy;
        if (isMovingCloser) {
          readout.textContent = "MOVING CLOSER (SHIFT +" + Math.round(netShift) + ")";
          readout.style.color = "#00ff66";
        } else {
          readout.textContent = "MOVING AWAY (SHIFT +" + Math.round(netShift) + ")";
          readout.style.color = "#00ccff";
        }
      } else {
        readout.textContent = "CLEAR";
        readout.style.color = "#66ff99";
      }

      requestAnimationFrame(update);
    }

    update();
  } catch (err) {
    readout.textContent = "ERROR: " + err.message;
  }
});
