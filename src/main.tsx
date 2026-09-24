import { createRoot } from 'react-dom/client';
import App from './App';
import VentanaOficina from './oficina/VentanaOficina';
import './index.css';

// La Oficina en vivo se abre en su propia ventana (ver `abrirOficina` en
// main.ts): misma app, otra vista.
createRoot(document.getElementById('root')!).render(location.hash === '#oficina' ? <VentanaOficina /> : <App />);
