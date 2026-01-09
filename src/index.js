const express = require('express');
const puppeteer = require('puppeteer-core');
const rateLimit = require('express-rate-limit');

const app = express();
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
  const { url, options = {} } = req.body;

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

    console.log(`Generating PDF for: ${url}`);

    // Navigate to URL
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // Emulate print media for better PDF rendering
    await page.emulateMediaType('print');

    // Default PDF options
    const pdfOptions = {
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20mm',
        bottom: '20mm',
        left: '15mm',
        right: '15mm'
      },
      displayHeaderFooter: false,
      preferCSSPageSize: false,
      ...options
    };

    const pdfBuffer = await page.pdf(pdfOptions);

    await browser.close();

    console.log(`PDF generated successfully. Size: ${pdfBuffer.length} bytes`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="document-${Date.now()}.pdf"`);
    res.status(200).end(pdfBuffer, 'binary');

  } catch (error) {
    if (browser && browser.process() != null) {
      await browser.close().catch(e => console.error('Error closing browser:', e));
    }
    
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
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await page.emulateMediaType('print');

    const pdfOptions = {
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20mm',
        bottom: '20mm',
        left: '15mm',
        right: '15mm'
      },
      displayHeaderFooter: false,
      preferCSSPageSize: false,
      ...options
    };

    const pdfBuffer = await page.pdf(pdfOptions);
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
    if (browser) await browser.close().catch(() => {});
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