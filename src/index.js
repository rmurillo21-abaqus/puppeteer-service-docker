const express = require('express');
const puppeteer = require('puppeteer-core');
const rateLimit = require('express-rate-limit');

const app = express();

const fetch = global.fetch || require('node-fetch');
app.set('trust proxy', true);

const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: {
    error: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Apply rate limiting to screenshot and PDF endpoints
app.use('/screenshot', limiter);
app.use('/pdf', limiter);

/**
 * URL validation utility
 */
const validateUrl = (url) => {
  try {
    const parsedUrl = new URL(url);
    return ['http:', 'https:'].includes(parsedUrl.protocol);
  } catch {
    return false;
  }
};

/**
 * Puppeteer configuration
 */
const launchBrowser = async () => {
  const executablePath = process.env.CHROME_BIN ||
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    '/usr/bin/google-chrome-stable';

  return puppeteer.launch({
    headless: 'new',
    executablePath: executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1920x1080',
      '--single-process',
      '--no-zygote',
      '--disable-accelerated-2d-canvas',
      '--disable-web-security',
      '--disable-features=site-per-process'
    ]
  });
};

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'puppeteer-fargate',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

/**
 * Root endpoint
 */
app.get('/', (req, res) => {
  res.status(200).json({
    service: 'Puppeteer Fargate Service',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      test: 'GET /test',
      screenshot: 'POST /screenshot',
      pdf: 'POST /pdf'
    }
  });
});

/**
 * Screenshot endpoint with improved error handling
 */
app.post('/screenshot', async (req, res) => {
  const { url, fullPage = true, quality, type = 'png' } = req.body;

  // Validate URL
  if (!url || !validateUrl(url)) {
    return res.status(400).json({
      error: 'Valid URL is required (must include http:// or https://)'
    });
  }

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });

    // Navigate to URL
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Configure screenshot options
    const screenshotOptions = {
      encoding: 'base64',
      fullPage: fullPage,
      type: type
    };

    // Add quality for JPEG
    if (type === 'jpeg' && quality) {
      screenshotOptions.quality = Math.min(Math.max(quality, 0), 100);
    }

    const screenshot = await page.screenshot(screenshotOptions);

    await browser.close();

    res.status(200).json({
      success: true,
      url: url,
      screenshot: screenshot,
      format: type,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    if (browser && browser.process() != null) {
      await browser.close().catch(e => console.error('Error closing browser:', e));
    }

    console.error('Screenshot error:', error);

    let statusCode = 500;
    let errorMessage = 'Failed to capture screenshot';

    if (error.message.includes('net::ERR_CONNECTION_REFUSED') ||
      error.message.includes('net::ERR_NAME_NOT_RESOLVED')) {
      statusCode = 400;
      errorMessage = 'Cannot connect to the URL or domain not found';
    } else if (error.message.includes('Timeout')) {
      statusCode = 408;
      errorMessage = 'Request timeout - the page took too long to load';
    } else if (error.message.includes('net::ERR_ABORTED')) {
      statusCode = 400;
      errorMessage = 'Navigation was aborted';
    }

    res.status(statusCode).json({
      error: errorMessage,
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * PDF generation endpoint
 */
app.post('/pdf', async (req, res) => {

  let browser;

  try {
    const { html, url, domainName, fields = {} } = req.body;

    if (!html && !url) {
      return res.status(400).json({ error: 'Missing html or url' });
    }

    if (url && !validateUrl(url)) {
      return res.status(400).json({ error: 'Valid URL is required (http/https)' });
    }

    /* -------------------------------------------------------
       FETCH BINARY DATA (SIGNATURES / FILE INPUTS)
    ------------------------------------------------------- */
    const fieldData = {};

    for (const key of Object.keys(fields)) {
      const data = fields[key];
      if (!data) continue;

      if (data.startsWith('http://') || data.startsWith('https://')) {
        try {
          const response = await fetch(
            `${domainName}/track/mgt?page=displayS3Data&pageName=formDataDisplay`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
              },
              body: new URLSearchParams({ txnID: data }).toString()
            }
          );
          fieldData[key] = await response.text();
        } catch (err) {
          console.error('Binary fetch failed for:', key, err);
          fieldData[key] = null;
        }
      }
    }

    /* -------------------------------------------------------
       LAUNCH PUPPETEER
    ------------------------------------------------------- */
    browser = await launchBrowser();

    const page = await browser.newPage();
    page.on('console', msg => console.log('PAGE:', msg.text()));

    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } else {
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
    }

    /* -------------------------------------------------------
       WAIT FOR LOADERS / SPINNERS TO DISAPPEAR
    ------------------------------------------------------- */
    await page.evaluate(async () => {
      const waitFor = (fn, timeout = 30000) =>
        new Promise((resolve, reject) => {
          const start = Date.now();
          const timer = setInterval(() => {
            if (fn()) {
              clearInterval(timer);
              resolve();
            }
            if (Date.now() - start > timeout) {
              clearInterval(timer);
              reject('Timeout waiting for UI');
            }
          }, 300);
        });

      await waitFor(() => {
        const spinner =
          document.querySelector('.loading') ||
          document.querySelector('.spinner') ||
          document.querySelector('[class*="loading"]') ||
          document.querySelector('[class*="spinner"]') ||
          document.querySelector('[aria-busy="true"]');

        return !spinner || spinner.offsetParent === null;
      });
    });

    /* -------------------------------------------------------
       LET UI STABILIZE
    ------------------------------------------------------- */
    await new Promise(resolve => setTimeout(resolve, 1000));
    await page.evaluate(() => document.body.offsetHeight);

    /* -------------------------------------------------------
       PRINT CSS (CRITICAL)
    ------------------------------------------------------- */
    await page.emulateMediaType('print');

    await page.addStyleTag({
      content: `
        body { margin:0; padding:0; background:white; }
        table { width:100%; border-collapse:collapse; page-break-inside:auto; }
        tr { page-break-inside:avoid; }
        thead { display:table-header-group; }
        canvas { display:block; page-break-inside:avoid; }
        .loading, .spinner { display:none !important; }
      `
    });

    const PDF_MARGIN = 40;
    const PAGE_WIDTH = 595 - 2 * PDF_MARGIN;
    const PAGE_HEIGHT = 842 - 2 * PDF_MARGIN;

    /* -------------------------------------------------------
       FILL FIELDS + RENDER FILES & SIGNATURES (SYNC SAFE)
    ------------------------------------------------------- */
    await page.evaluate(async (fields, fieldData, PAGE_WIDTH, PAGE_HEIGHT) => {

      const waitImage = img =>
        new Promise(res => (img.complete ? res() : (img.onload = res)));

      // Fill form fields
      for (const [name, value] of Object.entries(fields)) {
        const el = document.querySelector(`[name="${name}"]`) || document.getElementById(name);
        if (!el) continue;

        if (el.tagName === 'SELECT') {
          el.innerHTML = `<option selected>${value}</option>`;
        } else if (el.type === 'checkbox' || el.type === 'radio') {
          el.checked = value === true || value === 'Yes' || value === 'true' || value === 'On' || value === 'on' || value === 'yes';
        } else if ('value' in el) {
          el.value = value ?? '';
        }
      }

      // File inputs → images
      const fileInputs = [...document.querySelectorAll('input[type="file"]')];

      for (const input of fileInputs) {
        const key = input.name;
        const data = fieldData[key];
        if (!data || !data.startsWith('data:image')) continue;

        input.style.display = 'none';

        const img = new Image();
        img.src = data;
        await waitImage(img);

        const scale = Math.min(1, PAGE_WIDTH / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        input.after(canvas);
      }

      // Signature canvases
      const sigCanvases = [...document.querySelectorAll('canvas[name]')];

      for (const canvas of sigCanvases) {
        const key = canvas.getAttribute('name');
        const data = fieldData[key];
        if (!data) continue;

        const img = new Image();
        img.src = data;
        await waitImage(img);

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      }

    }, fields, fieldData, PAGE_WIDTH, PAGE_HEIGHT);

    /* -------------------------------------------------------
       FINAL WAIT (VERY IMPORTANT)
    ------------------------------------------------------- */
    await new Promise(resolve => setTimeout(resolve, 500));


    /* -------------------------------------------------------
       GENERATE PDF
    ------------------------------------------------------- */
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '40px', bottom: '60px', left: '40px', right: '40px' },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: `
        <div style="font-size:10px;width:100%;text-align:center;">
          Page <span class="pageNumber"></span> of <span class="totalPages"></span>
        </div>`
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="document-${Date.now()}.pdf"`);
    res.status(200).end(pdf);

  } catch (err) {
    console.error('PDF ERROR:', err);
    res.status(500).json({ error: 'PDF generation failed', message: err.message });
  } finally {
    if (browser) await browser.close();
  }
});


/**
 * PDF generation endpoint
 */
app.post('/pdf/base64', async (req, res) => {
  const { url, options = {} } = req.body;

  if (!url || !validateUrl(url)) {
    return res.status(400).json({
      error: 'Valid URL is required (must include http:// or https://)'
    });
  }

  let browser;
  try {

    await browser.close();

    // Retornar como JSON con base64
    res.status(200).json({
      success: true,
      url: url,
      pdf: pdfBuffer.toString('base64'),
      size: pdfBuffer.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    if (browser && browser.process() != null) {
      await browser.close().catch(e => console.error('Error closing browser:', e));
    }

    console.error('PDF generation error:', error);
    res.status(500).json({
      error: 'Failed to generate PDF',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Test endpoint for quick validation
 */
app.get('/test', async (req, res) => {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.goto('https://example.com', { timeout: 10000 });
    const title = await page.title();

    await browser.close();

    res.status(200).json({
      success: true,
      message: 'Puppeteer is working correctly',
      testPageTitle: title,
      chromeVersion: await browser.version(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (browser) await browser.close().catch(() => { });
    res.status(500).json({
      error: 'Puppeteer test failed',
      message: error.message
    });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

/**
 * Start server
 */
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Puppeteer service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Chrome executable: ${process.env.CHROME_BIN || 'default'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
