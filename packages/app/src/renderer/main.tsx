import React from 'react';
import { createRoot } from 'react-dom/client';
import { injectTheme } from './theme';
import { App } from './App';
import './index.css';

injectTheme();

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
