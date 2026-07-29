const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname)));

// --- Rate limiting ---
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);

const strictLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Too many requests, try again in an hour.' } });
app.use('/api/submit-contact', strictLimiter);
app.use('/api/subscribe', strictLimiter);

// --- Data helpers ---
const readData = (filename) => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', filename), 'utf-8')); }
  catch { return []; }
};

const writeData = (filename, data) => {
  fs.writeFileSync(path.join(__dirname, 'data', filename), JSON.stringify(data, null, 2), 'utf-8');
};

// --- Nodemailer transporter ---
// Uses Gmail App Password. Set EMAIL_USER and EMAIL_PASS in environment variables.
// If not set, email sending is skipped but data is still saved locally.
let transporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
  });
  console.log('Email transport configured');
} else {
  console.log('EMAIL_USER/EMAIL_PASS not set — emails will be saved locally only');
}

// --- API: Blog ---
app.get('/api/blogs', (req, res) => {
  const blogs = readData('blogs.json');
  const published = blogs.filter(b => b.published);
  published.sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json(published);
});

app.get('/api/blogs/:slug', (req, res) => {
  const blogs = readData('blogs.json');
  const blog = blogs.find(b => b.slug === req.params.slug && b.published);
  if (!blog) return res.status(404).json({ error: 'Post not found' });
  res.json(blog);
});

// --- API: Subscribe ---
app.post('/api/subscribe', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

  const subscribers = readData('subscribers.json');
  if (subscribers.find(s => s.email === email)) {
    return res.json({ message: 'Already subscribed', duplicate: true });
  }

  const sub = { email, subscribedAt: new Date().toISOString(), source: 'website' };
  subscribers.push(sub);
  writeData('subscribers.json', subscribers);

  // Send welcome email
  if (transporter) {
    try {
      await transporter.sendMail({
        from: `"Automate Sends" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Welcome to Automate Sends — your first tip is on the way',
        html: `<div style="font-family:Inter,sans-serif;max-width:500px">
          <h2 style="color:#1e3a5f">You're in! 🚀</h2>
          <p>Thanks for subscribing to Automate Sends. You'll get one actionable email marketing tip every week — real data, real examples, zero fluff.</p>
          <p>Check your inbox soon for your first one.</p>
          <p style="color:#888;font-size:12px">— Automate Sends</p>
        </div>`
      });
    } catch (err) { console.error('Welcome email failed:', err.message); }
  }

  res.json({ message: 'Subscribed successfully' });
});

// --- API: Contact ---
app.post('/api/submit-contact', async (req, res) => {
  const { name, email, brand, project_type, list_size, budget, message } = req.body;
  if (!name || !email || !message) return res.status(400).json({ error: 'Name, email, and message are required' });

  const contacts = readData('contacts.json');
  const contact = {
    id: Date.now().toString(36),
    name, email, brand, project_type, list_size, budget, message,
    submittedAt: new Date().toISOString()
  };
  contacts.push(contact);
  writeData('contacts.json', contacts);

  // Notify you
  if (transporter) {
    try {
      await transporter.sendMail({
        from: `"Automate Sends Form" <${process.env.EMAIL_USER}>`,
        to: process.env.EMAIL_USER,
        subject: `New inquiry from ${name} — via Automate Sends`,
        html: `<div style="font-family:Inter,sans-serif;max-width:500px">
          <h2>New Contact Form Submission</h2>
          <table cellpadding="6" style="border-collapse:collapse">
            <tr><td style="color:#555"><strong>Name</strong></td><td>${name}</td></tr>
            <tr><td style="color:#555"><strong>Email</strong></td><td>${email}</td></tr>
            <tr><td style="color:#555"><strong>Brand</strong></td><td>${brand || '—'}</td></tr>
            <tr><td style="color:#555"><strong>Project</strong></td><td>${project_type || '—'}</td></tr>
            <tr><td style="color:#555"><strong>List Size</strong></td><td>${list_size || '—'}</td></tr>
            <tr><td style="color:#555"><strong>Budget</strong></td><td>${budget || '—'}</td></tr>
            <tr><td style="color:#555"><strong>Message</strong></td><td>${message}</td></tr>
          </table>
          <p style="color:#888;font-size:12px;margin-top:16px">Reply directly to ${email}</p>
        </div>`
      });
      await transporter.sendMail({
        from: `"Automate Sends" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Thanks for reaching out — Automate Sends',
        html: `<div style="font-family:Inter,sans-serif;max-width:500px">
          <h2 style="color:#1e3a5f">Thanks for reaching out, ${name}!</h2>
          <p>I've received your message and will reply personally within 2 business days.</p>
          <p>In the meantime, check out <a href="https://automatesends.com#work" style="color:#4a90d9">our portfolio</a> to see what we've built for brands like yours.</p>
          <p style="color:#888;font-size:12px">— Automate Sends</p>
        </div>`
      });
    } catch (err) { console.error('Contact email failed:', err.message); }
  }

  res.json({ message: 'Message sent successfully' });
});

// --- API: Blog Admin (simple auth via token) ---
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'automate-admin-2026';

app.post('/api/admin/blog', (req, res) => {
  if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });

  const { title, slug, category, excerpt, image, published } = req.body;
  if (!title || !slug) return res.status(400).json({ error: 'Title and slug required' });

  const blogs = readData('blogs.json');
  const existing = blogs.findIndex(b => b.slug === slug);
  const entry = {
    id: slug,
    title, slug, category: category || 'General',
    date: new Date().toISOString().split('T')[0],
    author: 'Ahmad Hasan',
    readTime: req.body.readTime || '5 min read',
    excerpt: excerpt || '',
    image: image || '📝',
    published: published !== false
  };

  if (existing >= 0) { blogs[existing] = { ...blogs[existing], ...entry }; }
  else { blogs.push(entry); }

  writeData('blogs.json', blogs);
  res.json({ message: 'Blog saved', blog: entry });
});

app.delete('/api/admin/blog/:slug', (req, res) => {
  if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });
  let blogs = readData('blogs.json');
  blogs = blogs.filter(b => b.slug !== req.params.slug);
  writeData('blogs.json', blogs);
  res.json({ message: 'Blog deleted' });
});

// --- Admin stats ---
app.get('/api/admin/stats', (req, res) => {
  if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });
  res.json({
    subscribers: readData('subscribers.json').length,
    contacts: readData('contacts.json').length,
    blogs: readData('blogs.json').length,
    uptime: process.uptime()
  });
});

// --- Serve static HTML for all other routes ---
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  if (req.path.startsWith('/blog/') && req.path.endsWith('.html')) {
    return res.sendFile(path.join(__dirname, req.path));
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Automate Sends server running on http://localhost:${PORT}`);
  console.log(`Blog API: http://localhost:${PORT}/api/blogs`);
  console.log(`Subscribe: POST http://localhost:${PORT}/api/subscribe`);
  console.log(`Contact: POST http://localhost:${PORT}/api/submit-contact`);
});
