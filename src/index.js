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
      return res.status(400).json({
        error: 'Valid URL is required (http/https)'
      });
    }
    // ----------------- Fetch binary data -----------------
    const fieldData = {};
    for (const key of Object.keys(fields)) {
      const data = fields[key];
      if (!data) continue;
      if (data.startsWith('http://') || data.startsWith('https://')) {
        try {
          console.log('Fetching binary data for key:', key, 'from txnID:', data, " via domain:", domainName);
          const response = await fetch(
               `${domainName}/track/mgt?page=displayS3Data&pageName=formDataDisplay`,
               {
                 method: 'POST',
                 headers: {
                   'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
                 },
                 body: new URLSearchParams({
                   txnID: data
                 }).toString()
               }
             ); 
          fieldData[key] = await response.text();
        } catch (err) {
          console.error('Failed to fetch binary for', key, err);
          fieldData[key] = null;
        }
      }

    }

    // ----------------- Launch Puppeteer -----------------
    /*  browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      }); */
    browser = await launchBrowser();

    const page = await browser.newPage();

    page.on('console', msg => console.log('PAGE LOG:', msg.text()));

    if (url) {
      await page.goto(url, {
        waitUntil: 'networkidle0', timeout: 60000
      });
    } else {
      await page.setContent(html, { waitUntil: 'networkidle0' });
    }

    // Emulate print media for better PDF rendering
    await page.emulateMediaType('print');

    // ----------------- Print-safe CSS -----------------
    await page.addStyleTag({
      content: `
          table { page-break-inside: auto; border-collapse: collapse; width: 100%; }
          tr { page-break-inside: avoid; page-break-after: auto; }
          thead { display: table-header-group; }
          tfoot { display: table-footer-group; }
          canvas { page-break-inside: avoid; display: block; margin-bottom: 10px; }
          .pdf-image-wrapper { page-break-inside: avoid; margin-bottom: 20px; }
          .pdf-file-label { font-size: 12px; margin-top: 6px; color: #333; word-break: break-word; }
          body { margin: 0; padding: 0; background: inherit; }
        `
    });

    const PDF_MARGIN = 40;
    const PAGE_WIDTH = 595 - 2 * PDF_MARGIN;
    const PAGE_HEIGHT = 842 - 2 * PDF_MARGIN;

    // ----------------- Fill fields & render images/signatures -----------------
    await page.evaluate((fields, fieldData, PAGE_WIDTH, PAGE_HEIGHT) => {
      // Fill form fields
      for (const [name, value] of Object.entries(fields)) {
        const el = document.querySelector(`[name="${name}"]`) || document.getElementById(name);
        if (!el) continue;
        if (el.tagName === 'INPUT' && el.type === 'file') continue;
        if (el.tagName === 'SELECT') {
          el.innerHTML = `<option selected>${value}</option>`;
        } else if (el.type === 'checkbox' || el.type === 'radio') {
          el.checked = value === true || value === 'Yes' || value === 'true';
        } else if ('value' in el) {
          el.value = value ?? '';
        }
      }

      // FILE INPUTS → IMAGE/LABEL with multi-page support
      const fileInputs = [...document.querySelectorAll('input[type="file"]')];
      fileInputs.forEach(input => {
        const key = input.name?.trim();
        const data = fieldData[key];
        if (!data) return;

        input.style.display = 'none';
        const wrapper = document.createElement('div');
        wrapper.className = 'pdf-image-wrapper';

        if (data.startsWith('data:image')) {
          const img = new Image();
          img.src = data;
          img.onload = () => {
            const scale = Math.min(1, PAGE_WIDTH / img.width);
            const width = img.width * scale;
            let height = img.height * scale;
            let yOffset = 0;

            while (yOffset < height) {
              const canvas = document.createElement('canvas');
              const ctx = canvas.getContext('2d');
              const sliceHeight = Math.min(PAGE_HEIGHT, height - yOffset);

              canvas.width = width;
              canvas.height = sliceHeight;

              ctx.drawImage(img, 0, yOffset / scale, img.width, sliceHeight / scale, 0, 0, width, sliceHeight);
              wrapper.appendChild(canvas);

              yOffset += sliceHeight;
            }
          };
        } else {
          const label = document.createElement('div');
          label.className = 'pdf-file-label';
          label.textContent = `Attached file: ${key}`;
          wrapper.appendChild(label);
        }

        const nameLabel = document.createElement('div');
        nameLabel.className = 'pdf-file-label';
        nameLabel.textContent = key;
        wrapper.appendChild(nameLabel);

        input.after(wrapper);
      });

      // SIGNATURE CANVASES
      const canvases = [...document.querySelectorAll('canvas')];
      canvases.forEach(canvas => {
        const key = canvas.getAttribute('name')?.trim();
        const data = fieldData[key];
        if (!data || !data.startsWith('data:image')) return;

        const ctx = canvas.getContext('2d');
        const img = new Image();
        img.src = data;
        img.onload = () => {
          const scale = Math.min(1, PAGE_WIDTH / img.width);
          const width = img.width * scale;
          let height = img.height * scale;
          let yOffset = 0;

          while (yOffset < height) {
            const sliceCanvas = document.createElement('canvas');
            const sliceCtx = sliceCanvas.getContext('2d');
            const sliceHeight = Math.min(PAGE_HEIGHT, height - yOffset);

            sliceCanvas.width = width;
            sliceCanvas.height = sliceHeight;
            sliceCtx.drawImage(img, 0, yOffset / scale, img.width, sliceHeight / scale, 0, 0, width, sliceHeight);
            canvas.parentNode.insertBefore(sliceCanvas, canvas.nextSibling);

            yOffset += sliceHeight;
          }
          canvas.remove();
        };
      });

    }, fields, fieldData, PAGE_WIDTH, PAGE_HEIGHT);

    // Optional debug HTML
    if (process.env.DEBUG_PDF === 'true') {
      const fs = require('fs');
      fs.writeFileSync('debug-rendered.html', await page.content());
    }

    // ----------------- Generate PDF with page numbers -----------------
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '40px', bottom: '60px', left: '40px', right: '40px' },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>', // empty header
      footerTemplate: `
          <div style="font-size:10px; width:100%; text-align:center; color:#555;">
            Page <span class="pageNumber"></span> of <span class="totalPages"></span>
          </div>
        `

    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdf.length);
    res.setHeader('Content-Disposition', `attachment; filename="document-${Date.now()}.pdf"`);
    res.status(200).end(pdf, 'binary');

  } catch (error) {

    console.error('PDF generation error:', error);

    let statusCode = 500;
    let errorMessage = 'Failed to generate PDF';

    if (error.message.includes('net::ERR_CONNECTION_REFUSED') ||
      error.message.includes('net::ERR_NAME_NOT_RESOLVED')) {
      statusCode = 400;
      errorMessage = 'Cannot connect to the URL or domain not found';
    } else if (error.message.includes('Timeout')) {
      statusCode = 408;
      errorMessage = 'Request timeout - the page took too long to load';
    }

    res.status(statusCode).json({
      error: errorMessage,
      message: error.message,
      timestamp: new Date().toISOString()
    });
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