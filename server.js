import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3001;

// Expose the 'public' directory for standard HTML/JS/CSS
app.use(express.static(path.join(__dirname, 'public')));

// Expose 'node_modules/three' so the browser can import it
app.use(
  '/node_modules/three',
  express.static(path.join(__dirname, 'node_modules', 'three'))
);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(`Vanilla JS Server up at http://localhost:${port}`);
});
