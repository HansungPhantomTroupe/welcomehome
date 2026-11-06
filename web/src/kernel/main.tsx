import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import KernelLab from './KernelLab';
import '../styles.css';
import './kernel.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <KernelLab />
  </StrictMode>,
);
