import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './estilos.css';

if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // Silenciar en entornos de prueba sin soporte SW
    });
  });
}

const contenedor = document.getElementById('root');
if (!contenedor) {
  throw new Error('No se encontró el elemento #root');
}

createRoot(contenedor).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
