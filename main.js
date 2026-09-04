// --- CONFIGURATION ---
const INPUT_IMAGE = './krishna.png';
const CANVAS_W = 1920;
const CANVAS_H = 1080;
const FPS = 60;

const DOT_REVEAL_SECONDS = 3.5;
const REFINE_SECONDS = 3.0;
const HOLD_SECONDS = 3.0;
const CROSSFADE_SECONDS = 1.5;
const FINAL_HOLD_SECONDS = 3.0;

const MOSAIC_BLOCK_SIZE = 10;
const DARK_PIXEL_SKIP = 18;
const REFLECTION_HEIGHT_RATIO = 0.28;

let canvas, ctx;
let audio;
let baseCanvas, neonCanvas, sharpFrameCanvas;
let animationStartTime = 0;
let isAnimating = false;

// We will need random but deterministic order, or just normal random is fine for JS
function shuffle(array) {
  let currentIndex = array.length, randomIndex;
  while (currentIndex !== 0) {
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;
    [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
  }
  return array;
}

// Fit image into the canvas
function createBaseCanvas(img, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const cCtx = c.getContext('2d');
  
  const scale = Math.min(w / img.width, h / img.height);
  const newW = img.width * scale;
  const newH = img.height * scale;
  const xOff = (w - newW) / 2;
  const yOff = (h - newH) / 2;
  
  cCtx.fillStyle = 'black';
  cCtx.fillRect(0, 0, w, h);
  cCtx.drawImage(img, xOff, yOff, newW, newH);
  
  return c;
}

// Sobel edge detection in JS
function makeNeonEdgeLayer(baseC) {
  const w = baseC.width;
  const h = baseC.height;
  
  const cCtx = baseC.getContext('2d');
  const imgData = cCtx.getImageData(0, 0, w, h);
  const data = imgData.data;
  
  const edgeC = document.createElement('canvas');
  edgeC.width = w;
  edgeC.height = h;
  const edgeCtx = edgeC.getContext('2d');
  const edgeImgData = edgeCtx.createImageData(w, h);
  const eData = edgeImgData.data;
  
  const sobelX = [
    [-1, 0, 1],
    [-2, 0, 2],
    [-1, 0, 1]
  ];
  const sobelY = [
    [-1, -2, -1],
    [ 0,  0,  0],
    [ 1,  2,  1]
  ];
  
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let pxX = 0;
      let pxY = 0;
      let pxX_g = 0, pxY_g = 0;
      let pxX_b = 0, pxY_b = 0;
      
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const weightX = sobelX[ky + 1][kx + 1];
          const weightY = sobelY[ky + 1][kx + 1];
          const idx = ((y + ky) * w + (x + kx)) * 4;
          
          pxX += data[idx] * weightX;
          pxY += data[idx] * weightY;
          pxX_g += data[idx+1] * weightX;
          pxY_g += data[idx+1] * weightY;
          pxX_b += data[idx+2] * weightX;
          pxY_b += data[idx+2] * weightY;
        }
      }
      
      const val = Math.sqrt(pxX * pxX + pxY * pxY);
      const val_g = Math.sqrt(pxX_g * pxX_g + pxY_g * pxY_g);
      const val_b = Math.sqrt(pxX_b * pxX_b + pxY_b * pxY_b);
      
      const outIdx = (y * w + x) * 4;
      
      if (val > 60 || val_g > 60 || val_b > 60) {
        // Boost color from original
        eData[outIdx] = Math.min(255, data[outIdx] * 1.5);
        eData[outIdx+1] = Math.min(255, data[outIdx+1] * 1.7);
        eData[outIdx+2] = Math.min(255, data[outIdx+2] * 1.5 + 60);
        eData[outIdx+3] = 255;
      } else {
        eData[outIdx] = 0;
        eData[outIdx+1] = 0;
        eData[outIdx+2] = 0;
        eData[outIdx+3] = 255;
      }
    }
  }
  
  edgeCtx.putImageData(edgeImgData, 0, 0);
  
  // Now apply glow
  const neonC = document.createElement('canvas');
  neonC.width = w;
  neonC.height = h;
  const nCtx = neonC.getContext('2d');
  
  nCtx.fillStyle = 'black';
  nCtx.fillRect(0, 0, w, h);
  
  nCtx.globalCompositeOperation = 'lighter';
  
  // Base edges
  nCtx.globalAlpha = 1.0;
  nCtx.drawImage(edgeC, 0, 0);
  
  // Inner glow
  nCtx.filter = 'blur(4px)';
  nCtx.globalAlpha = 0.8;
  nCtx.drawImage(edgeC, 0, 0);
  
  // Outer glow
  nCtx.filter = 'blur(14px)';
  nCtx.globalAlpha = 0.5;
  nCtx.drawImage(edgeC, 0, 0);
  
  nCtx.filter = 'none';
  nCtx.globalCompositeOperation = 'source-over';
  nCtx.globalAlpha = 1.0;
  
  return neonC;
}

// Extract blocks for animation
function getBlockGrid(imgCanvas, blockSize) {
  const w = imgCanvas.width;
  const h = imgCanvas.height;
  const ctx = imgCanvas.getContext('2d', { willReadFrequently: true });
  const imgData = ctx.getImageData(0, 0, w, h).data;
  
  const blocks = [];
  
  for (let y = 0; y < h; y += blockSize) {
    for (let x = 0; x < w; x += blockSize) {
      // Find average or center color of block
      const cY = Math.min(y + Math.floor(blockSize / 2), h - 1);
      const cX = Math.min(x + Math.floor(blockSize / 2), w - 1);
      const idx = (cY * w + cX) * 4;
      
      const r = imgData[idx];
      const g = imgData[idx+1];
      const b = imgData[idx+2];
      
      if (Math.max(r, g, b) > DARK_PIXEL_SKIP) {
        blocks.push({
          x: x,
          y: y,
          w: Math.min(blockSize, w - x),
          h: Math.min(blockSize, h - y),
          color: `rgb(${r},${g},${b})`
        });
      }
    }
  }
  
  return shuffle(blocks);
}

function addReflection(sourceCanvas) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  
  const outCanvas = document.createElement('canvas');
  outCanvas.width = w;
  outCanvas.height = h;
  const outCtx = outCanvas.getContext('2d');
  
  outCtx.drawImage(sourceCanvas, 0, 0);
  
  const reflH = Math.floor(h * REFLECTION_HEIGHT_RATIO);
  const startY = h - reflH;
  
  outCtx.save();
  outCtx.translate(0, h + startY);
  outCtx.scale(1, -1);
  outCtx.globalCompositeOperation = 'screen';
  outCtx.globalAlpha = 0.35;
  
  // We only want to draw the bottom portion
  outCtx.drawImage(sourceCanvas, 0, startY, w, reflH, 0, startY, w, reflH);
  outCtx.restore();
  
  // Fade out gradient for reflection
  const gradient = outCtx.createLinearGradient(0, startY, 0, h);
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(1, 'rgba(0,0,0,1)');
  
  outCtx.globalCompositeOperation = 'destination-out';
  outCtx.fillStyle = gradient;
  outCtx.fillRect(0, startY, w, reflH);
  
  outCtx.globalCompositeOperation = 'source-over';
  
  return outCanvas;
}

let renderBlocks = [];
let dotRevealFrames = 0;
let currentRevealFrame = 0;
let totalBlocks = 0;
let refinedCanvas;

// Main animation loop
function animate(timestamp) {
  if (!animationStartTime) animationStartTime = timestamp;
  const elapsedSeconds = (timestamp - animationStartTime) / 1000;
  
  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  
  if (elapsedSeconds < DOT_REVEAL_SECONDS) {
    // 1. Dot Reveal
    const progress = elapsedSeconds / DOT_REVEAL_SECONDS;
    const target = Math.floor(totalBlocks * progress);
    
    // Draw on refinedCanvas incrementally
    const rCtx = refinedCanvas.getContext('2d');
    for (let i = currentRevealFrame; i < target; i++) {
      const block = renderBlocks[i];
      if(!block) continue;
      rCtx.fillStyle = block.color;
      rCtx.beginPath();
      const cx = block.x + block.w / 2;
      const cy = block.y + block.h / 2;
      const radius = Math.max(1, Math.min(block.w, block.h) / 2);
      rCtx.arc(cx, cy, radius, 0, Math.PI * 2);
      rCtx.fill();
    }
    currentRevealFrame = target;
    
    const reflected = addReflection(refinedCanvas);
    ctx.drawImage(reflected, 0, 0, canvas.width, canvas.height);
    
    requestAnimationFrame(animate);
    
  } else if (elapsedSeconds < DOT_REVEAL_SECONDS + REFINE_SECONDS) {
    // 2. Refine Edge Sketch
    const progress = (elapsedSeconds - DOT_REVEAL_SECONDS) / REFINE_SECONDS;
    const blockSize = Math.max(1, Math.floor(MOSAIC_BLOCK_SIZE * Math.pow(1 - progress, 2)));
    
    // Instead of completely redrawing mosaic which is heavy, we'll blend towards the neon canvas
    const frameCanvas = document.createElement('canvas');
    frameCanvas.width = CANVAS_W;
    frameCanvas.height = CANVAS_H;
    const fCtx = frameCanvas.getContext('2d');
    
    fCtx.globalAlpha = 1 - progress;
    fCtx.drawImage(refinedCanvas, 0, 0);
    fCtx.globalAlpha = progress;
    fCtx.drawImage(neonCanvas, 0, 0);
    
    const reflected = addReflection(frameCanvas);
    ctx.drawImage(reflected, 0, 0, canvas.width, canvas.height);
    
    requestAnimationFrame(animate);
    
  } else if (elapsedSeconds < DOT_REVEAL_SECONDS + REFINE_SECONDS + HOLD_SECONDS) {
    // 3. Hold Sketch
    ctx.drawImage(sharpFrameCanvas, 0, 0, canvas.width, canvas.height);
    requestAnimationFrame(animate);
    
  } else if (elapsedSeconds < DOT_REVEAL_SECONDS + REFINE_SECONDS + HOLD_SECONDS + CROSSFADE_SECONDS) {
    // 4. Crossfade
    const progress = (elapsedSeconds - (DOT_REVEAL_SECONDS + REFINE_SECONDS + HOLD_SECONDS)) / CROSSFADE_SECONDS;
    
    ctx.drawImage(sharpFrameCanvas, 0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = progress;
    ctx.drawImage(baseCanvas, 0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1.0;
    
    requestAnimationFrame(animate);
    
  } else {
    // 5. Final Hold
    ctx.drawImage(baseCanvas, 0, 0, canvas.width, canvas.height);
    
    // Show Happy Janmashtami text
    const endOverlay = document.getElementById('end-overlay');
    if (endOverlay && !endOverlay.classList.contains('visible')) {
      endOverlay.classList.remove('hidden');
      endOverlay.classList.add('visible');
    }
    
    // End of animation loop
  }
}

function resizeCanvas() {
  // Now handled purely by CSS object-fit: cover
}



async function init() {
  canvas = document.getElementById('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  ctx = canvas.getContext('2d');
  audio = document.getElementById('bg-music');
  
  resizeCanvas();
  
  const startBtn = document.getElementById('start-btn');
  const overlay = document.getElementById('start-overlay');
  startBtn.innerText = 'Loading Assets...';
  startBtn.disabled = true;
  
  const img = new Image();
  img.src = INPUT_IMAGE;
  await new Promise(r => img.onload = r);
  
  baseCanvas = createBaseCanvas(img, CANVAS_W, CANVAS_H);
  
  startBtn.innerText = 'Processing Effects...';
  
  // Use timeout to allow UI update
  setTimeout(() => {
    neonCanvas = makeNeonEdgeLayer(baseCanvas);
    sharpFrameCanvas = addReflection(neonCanvas);
    
    renderBlocks = getBlockGrid(neonCanvas, MOSAIC_BLOCK_SIZE);
    totalBlocks = renderBlocks.length;
    
    refinedCanvas = document.createElement('canvas');
    refinedCanvas.width = CANVAS_W;
    refinedCanvas.height = CANVAS_H;
    
    startBtn.innerText = 'Experience the Divine';
    startBtn.disabled = false;
    
    startBtn.addEventListener('click', () => {
      overlay.classList.add('hidden');
      audio.currentTime = 11;
      audio.play().catch(e => console.error("Audio playback failed:", e));
      
      setTimeout(() => {
        requestAnimationFrame(animate);
      }, 500); // Small delay for fade out
    });
  }, 100);
}

init();
