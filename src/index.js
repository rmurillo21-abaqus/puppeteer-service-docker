const express = require('express');
const puppeteer = require('puppeteer-core');
const rateLimit = require('express-rate-limit');
const archiver = require('archiver');
const pLimit = require('p-limit');

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
    const { html, url, domainName, dateDisplayFormat, headerInfo = {}, fields = {} } = req.body;

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

      if ((data.includes('amazonaws.com')) && (data.startsWith('http://') || data.startsWith('https://'))) {
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
    await page.evaluate(async (fields, fieldData, dateDisplayFormat, PAGE_WIDTH, PAGE_HEIGHT) => {

      const waitImage = (img, timeout = 15000) =>
        new Promise(resolve => {
          const done = () => resolve();

          if (img.complete) return done();

          const t = setTimeout(done, timeout);
          img.onload = () => { clearTimeout(t); done(); };
          img.onerror = () => { clearTimeout(t); done(); };
        });

      // HELPER: Simple Date Formatter
      const formatDataValue = (rawVal, fmt) => {
        const d = new Date(rawVal);
        if (isNaN(d.getTime())) return rawVal; // Return original if not a valid date

        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yyyy = d.getFullYear();
        const yy = String(yyyy).slice(-2);

        // Replace tokens in the format string
        return fmt
          .replace(/YYYY/g, yyyy)
          .replace(/YY/g, yy)
          .replace(/MM/g, mm)
          .replace(/DD/g, dd)
          .replace(/dd/g, dd); // Handle lowercase dd too
      };

      // Fill form fields
      for (const [name, value] of Object.entries(fields)) {
        try {
          const el = document.querySelector(`[name="${name}"]`) || document.getElementById(name);
          if (!el) continue;


          // IMPORTANT: never set value for file inputs (browser security restriction)
          if (el.tagName === 'INPUT' && el.type === 'file') {
            continue;
          }
          if (name.toLowerCase().includes('date')) {
            // Force type to text so the browser doesn't use its internal US-format display
            el.type = 'text';
            // Convert the raw date to the requested format
            el.value = formatDataValue(value ?? '', dateDisplayFormat);
            continue;
          }
          if (el.tagName === 'SELECT') {
            el.innerHTML = `<option selected>${value}</option>`;
          } else if (el.type === 'checkbox' || el.type === 'radio') {
            el.checked = value === true || value === 'Yes' || value === 'true' || value === 'On' || value === 'on' || value === 'yes';
          } else if (el.tagName === 'TEXTAREA') {
            el.value = value ?? '';
            el.innerHTML = value ?? '';
            // Ensure text wraps properly in PDF
            el.style.whiteSpace = 'pre-wrap';
            el.style.wordBreak = 'break-word';
            el.style.wordWrap = 'break-word';
          } else if ('value' in el) {
            el.value = value ?? '';
          }
        } catch (fieldErr) {
          console.error(`Error filling field ${name}:`, value);
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

      // ✅ FIX: Ensure textarea values are visible in PDF
      const textareas = document.querySelectorAll('textarea');
      textareas.forEach(el => {
        /* const div = document.createElement('div');
         div.textContent = el.value || '';

         div.style.whiteSpace = 'pre-wrap';
         div.style.wordBreak = 'break-word';
         div.style.width = '100%';
         div.style.fontSize = window.getComputedStyle(el).fontSize;
         div.style.fontFamily = window.getComputedStyle(el).fontFamily; */

        el.style.height = 'auto';
        // Set height to match the internal content height
        el.style.height = (el.scrollHeight) + 'px';
        // el.replaceWith(div);
      });

    }, fields, fieldData, dateDisplayFormat, PAGE_WIDTH, PAGE_HEIGHT);

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
      margin: { top: '70px', bottom: '60px', left: '40px', right: '40px' },
      displayHeaderFooter: true,
      headerTemplate: `<div style="
  width:100%;
  font-family: Arial, sans-serif;
  font-size:10px;
  color:#333;
  padding:6px 40px;
  box-sizing:border-box;
">
  
  <table style="width:100%; border-bottom:1px solid #e5e7eb; padding-bottom:6px;">
    <tr>
      <td style="text-align:left; vertical-align:middle;">
        <div style="font-size:11px; color:#6b7280;">
          
          <span style="font-weight:550;">Form Name:</span>
          <span style="font-weight:500;">${headerInfo?.formName || 'N/A'}</span>

          <span style="font-weight:550;">&nbsp;&nbsp; User:</span>
          <span style="font-weight:500;">${headerInfo?.user || 'N/A'}</span>

          <span style="font-weight:550;">&nbsp;&nbsp; Time:</span>
          <span style="font-weight:500;">${headerInfo?.date || 'N/A'}</span>

          <span style="font-weight:550;">&nbsp;&nbsp; Location:</span>
          <span style="font-weight:500;">${headerInfo?.location || 'N/A'}</span>

        </div>    
      </td>
    </tr>
  </table>

</div>`,
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
 * Batch PDF generation endpoint (returns a ZIP file)
 */
app.post('/pdf-batch', async (req, res) => {
  let browser;

  try {
    const batch = req.body;

    // Validate that the request body is an array
    if (!Array.isArray(batch) || batch.length === 0) {
      return res.status(400).json({ error: 'Request body must be an array of objects.' });
    }

    /* -------------------------------------------------------
       INITIALIZE ZIP STREAM IMMEDIATELY
    ------------------------------------------------------- */
    // Set headers for ZIP download right away
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="batch-documents-${Date.now()}.zip"`);

    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    });

    archive.on('warning', function (err) {
      if (err.code === 'ENOENT') {
        console.warn('Archiver warning:', err);
      } else {
        throw err;
      }
    });

    archive.on('error', function (err) {
      throw err;
    });

    // Pipe archive data directly to the HTTP response
    archive.pipe(res);

    /* -------------------------------------------------------
       LAUNCH PUPPETEER ONCE FOR THE ENTIRE BATCH
    ------------------------------------------------------- */
    // Assuming launchBrowser() is defined elsewhere in your code
    browser = await launchBrowser();

    /* -------------------------------------------------------
       SET CONCURRENCY LIMIT (Processing 5 PDFs simultaneously)
    ------------------------------------------------------- */
    const limit = pLimit(5);

    /* -------------------------------------------------------
       MAP ITEMS TO CONCURRENT PROMISES
    ------------------------------------------------------- */
    const processingPromises = batch.map((item, i) => limit(async () => {
      const { html, url, domainName, headerInfo = {}, fields = {} } = item;

      if (!html && !url) {
        console.warn(`Item ${i} skipped: Missing html or url`);
        return; // Skip invalid items
      }

      if (url && !validateUrl(url)) {
        console.warn(`Item ${i} skipped: Invalid URL`);
        return;
      }

      /* -------------------------------------------------------
         FETCH BINARY DATA (SIGNATURES / FILE INPUTS) IN PARALLEL
      ------------------------------------------------------- */
      const fieldData = {};
      const fetchPromises = Object.entries(fields).map(async ([key, data]) => {
        if (data && typeof data === 'string' && data.includes('amazonaws.com') && (data.startsWith('http://') || data.startsWith('https://'))) {
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
            console.error(`Binary fetch failed for item ${i}, key: ${key}`, err);
            fieldData[key] = null;
          }
        }
      });

      // Wait for all fetches for this specific page to complete simultaneously
      await Promise.all(fetchPromises);

      /* -------------------------------------------------------
         PROCESS PAGE
      ------------------------------------------------------- */
      const page = await browser.newPage();
      page.on('console', msg => console.log(`PAGE ${i}:`, msg.text()));

      try {
        if (url) {
          // networkidle0 waits until there are no more than 0 network connections for at least 500ms
          await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
        } else {
          await page.setContent(html, { waitUntil: ['domcontentloaded', 'networkidle0'] });
        }

        /* -------------------------------------------------------
           WAIT FOR LOADERS / SPINNERS TO DISAPPEAR
        ------------------------------------------------------- */
        await page.waitForFunction(() => {
          const spinners = document.querySelectorAll(
            '.loading, .spinner, [class*="loading"], [class*="spinner"], [aria-busy="true"]'
          );
          // Return true only when all spinners are hidden from the layout
          return Array.from(spinners).every(el => el.offsetParent === null);
        }, { timeout: 30000 });

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
           FILL FIELDS + RENDER FILES & SIGNATURES
        ------------------------------------------------------- */
        await page.evaluate(async (fields, fieldData, PAGE_WIDTH, PAGE_HEIGHT) => {
          const waitImage = (img, timeout = 15000) =>
            new Promise(resolve => {
              const done = () => resolve();
              if (img.complete) return done();
              const t = setTimeout(done, timeout);
              img.onload = () => { clearTimeout(t); done(); };
              img.onerror = () => { clearTimeout(t); done(); };
            });

          // Fill form fields
          for (const [name, value] of Object.entries(fields)) {
            const el = document.querySelector(`[name="${name}"]`) || document.getElementById(name);
            if (!el) continue;

            if (el.tagName === 'INPUT' && el.type === 'file') continue;

            if (el.tagName === 'SELECT') {
              el.innerHTML = `<option selected>${value}</option>`;
            } else if (el.type === 'checkbox' || el.type === 'radio') {
              el.checked = value === true || value === 'Yes' || value === 'true' || value === 'On' || value === 'on' || value === 'yes';
            } else if (el.tagName === 'TEXTAREA') {
              el.value = value ?? '';
              el.innerHTML = value ?? '';
              el.style.whiteSpace = 'pre-wrap';
              el.style.wordBreak = 'break-word';
              el.style.wordWrap = 'break-word';
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

          // Fix textarea visibility
          const textareas = document.querySelectorAll('textarea');
          textareas.forEach(el => {
            el.style.height = 'auto';
            el.style.height = (el.scrollHeight) + 'px';
          });

        }, fields, fieldData, PAGE_WIDTH, PAGE_HEIGHT);

        /* -------------------------------------------------------
           FINAL WAIT & GENERATE PDF BUFFER
        ------------------------------------------------------- */
        // A brief pause just to ensure canvas paints are committed before snapshot
        await new Promise(resolve => setTimeout(resolve, 500));

        const pdfBuffer = await page.pdf({
          format: 'A4',
          printBackground: true,
          preferCSSPageSize: true,
          margin: { top: '70px', bottom: '60px', left: '40px', right: '40px' },
          displayHeaderFooter: true,
          headerTemplate: `<div style="width:100%; font-family: Arial, sans-serif; font-size:10px; color:#333; padding:6px 40px; box-sizing:border-box;">
          <table style="width:100%; border-bottom:1px solid #e5e7eb; padding-bottom:6px;">
            <tr>
              <td style="text-align:left; vertical-align:middle;">
                <div style="font-size:11px; color:#6b7280;">
                  <span style="font-weight:550;">Form Name:</span>
                  <span style="font-weight:500;">${headerInfo?.formName || 'N/A'}</span>
                  <span style="font-weight:550;">&nbsp;&nbsp; User:</span>
                  <span style="font-weight:500;">${headerInfo?.user || 'N/A'}</span>
                  <span style="font-weight:550;">&nbsp;&nbsp; Time:</span>
                  <span style="font-weight:500;">${headerInfo?.date || 'N/A'}</span>
                  <span style="font-weight:550;">&nbsp;&nbsp; Location:</span>
                  <span style="font-weight:500;">${headerInfo?.location || 'N/A'}</span>
                </div>    
              </td>
            </tr>
          </table>
        </div>`,
          footerTemplate: `
          <div style="font-size:10px;width:100%;text-align:center;">
            Page <span class="pageNumber"></span> of <span class="totalPages"></span>
          </div>`
        });

        // Format a clean filename for the ZIP
        const userName = (headerInfo?.user || `user-${i}`).replace(/[^a-z0-9]/gi, '_');
        const formName = (headerInfo?.formName || `form`).replace(/[^a-z0-9]/gi, '_');
        const filename = `${formName}_${userName}_${Date.now()}.pdf`;

        /* -------------------------------------------------------
           STREAM DIRECTLY TO ARCHIVE (Frees Memory Instantly)
        ------------------------------------------------------- */
        archive.append(Buffer.from(pdfBuffer), { name: filename });

      } catch (itemErr) {
        console.error(`Error processing item ${i}:`, itemErr);
        // Continue with next items even if one fails
      } finally {
        // Clean up page resources immediately after use
        await page.close();
      }
    }));

    /* -------------------------------------------------------
       WAIT FOR ALL CONCURRENT PROCESSES TO FINISH
    ------------------------------------------------------- */
    await Promise.all(processingPromises);

    /* -------------------------------------------------------
       FINALIZE THE STREAM
    ------------------------------------------------------- */
    // This finishes the ZIP stream and safely closes the HTTP connection
    await archive.finalize();

  } catch (err) {
    console.error('BATCH PDF ERROR:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Batch PDF generation failed', message: err.message });
    }
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