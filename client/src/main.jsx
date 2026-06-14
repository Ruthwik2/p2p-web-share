import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// Note: StrictMode is intentionally omitted. Its development-only double mount
// would create two signaling connections (and two share rooms) per load, which
// is the wrong behaviour for a stateful realtime app. Effects here are written
// to tear down cleanly on unmount regardless.
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
