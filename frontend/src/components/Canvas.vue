<script setup>
import { ref, onMounted } from 'vue';
const canvasRef = ref(null);

onMounted(() => {
  const canvas = canvasRef.value;
  if (!canvas) return;
  // write ur fetch logic to codesandbox here :)
});
</script>

<template>
  <div class="canvas-container">
    <canvas ref="canvasRef" width="600" height="400"></canvas>
  </div>
</template>

<style scoped>
.canvas-container {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100vh;
  background-color: #f5f5f5;
}
canvas {
  border: 2px solid #35495e;
  background: white;
}
</style>