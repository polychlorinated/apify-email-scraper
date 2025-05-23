import { Actor } from 'apify';
import { PuppeteerCrawler } from 'crawlee';
import * as cheerio from 'cheerio';

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/gi;

// Optimized configuration for fast, limited scraping
const maxConcurrency = parseInt(process.env.MAX_CONCURRENCY || '1', 10); // Reduced for stability
const maxRequestsPerCrawl = parseInt(process.env.MAX_REQUESTS_PER_CRAWL || '3', 10); // Max 3 pages
const headless = process.env.HEADLESS !== 'false';
const timeout = parseInt(process.env.TIMEOUT || '15000', 10); // Reduced timeout
const requestDelay = parseInt(process.env.REQUEST_DELAY || '0', 10); // No delay for 3 pages

await Actor.main(async () => {
    const input = await Actor.getInput();
    const startUrl = input?.url;

    // Validate input
    if (!startUrl || !startUrl.startsWith('http')) {
        throw new Error('Valid URL required');
    }

    const dataset = await Actor.openDataset();
    const uniqueEmails = new Set();
    const processedUrls = new Set();
    let pagesProcessed = 0;

    console.log('Starting email scraper with optimized configuration:');
    console.log(`URL: ${startUrl}`);
    console.log(`Max Pages: ${maxRequestsPerCrawl}`);
    console.log(`Concurrency: ${maxConcurrency}`);
    console.log(`Timeout: ${timeout}ms`);

    const crawler = new PuppeteerCrawler({
        maxConcurrency,
        maxRequestsPerCrawl,
        navigationTimeoutSecs: Math.ceil(timeout / 1000),
        
        // Optimized browser settings for stability
        launchContext: {
            launchOptions: {
                headless,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    '--disable-gpu'
                ]
            }
        },
        
        // Preprocessing to skip unnecessary pages
        preNavigationHooks: [
            async ({ request }, gotoOptions) => {
                // Skip if we've already processed enough pages
                if (pagesProcessed >= maxRequestsPerCrawl) {
                    request.noRetry = true;
                    throw new Error('Max pages reached');
                }
                
                // Configure navigation for better stability
                gotoOptions.waitUntil = 'domcontentloaded'; // Faster than 'networkidle2'
                gotoOptions.timeout = timeout;
            }
        ],
        
        // Handle each page
        async requestHandler({ request, page, enqueueLinks }) {
            try {
                const url = request.url;
                
                // Skip if already processed
                if (processedUrls.has(url)) {
                    console.log(`Skipping already processed: ${url}`);
                    return;
                }
                
                processedUrls.add(url);
                pagesProcessed++;
                console.log(`Processing page ${pagesProcessed}/${maxRequestsPerCrawl}: ${url}`);
                
                // Wait for basic content with shorter timeout
                try {
                    await page.waitForSelector('body', { timeout: 5000 });
                } catch (e) {
                    console.log('Body not found quickly, proceeding anyway...');
                }
                
                // Get page content - multiple methods for robustness
                let emails = [];
                
                // Method 1: Get from page text content
                try {
                    const textContent = await page.evaluate(() => document.body.innerText || document.body.textContent || '');
                    const textEmails = textContent.match(EMAIL_REGEX) || [];
                    emails = emails.concat(textEmails);
                } catch (e) {
                    console.log('Error getting text content:', e.message);
                }
                
                // Method 2: Get from HTML if text extraction failed
                if (emails.length === 0) {
                    try {
                        const html = await page.content();
                        const $ = cheerio.load(html);
                        const htmlText = $('body').text();
                        const htmlEmails = htmlText.match(EMAIL_REGEX) || [];
                        emails = emails.concat(htmlEmails);
                    } catch (e) {
                        console.log('Error parsing HTML:', e.message);
                    }
                }
                
                // Method 3: Look for mailto links
                try {
                    const mailtoEmails = await page.evaluate(() => {
                        const links = Array.from(document.querySelectorAll('a[href^="mailto:"]'));
                        return links.map(link => link.href.replace('mailto:', '').split('?')[0]);
                    });
                    emails = emails.concat(mailtoEmails);
                } catch (e) {
                    console.log('Error finding mailto links:', e.message);
                }
                
                console.log(`Found ${emails.length} potential emails on ${url}`);
                
                // Store unique emails
                for (const email of emails) {
                    const cleanEmail = email.toLowerCase().trim();
                    // Basic validation
                    if (cleanEmail.includes('@') && cleanEmail.includes('.') && !uniqueEmails.has(cleanEmail)) {
                        uniqueEmails.add(cleanEmail);
                        await dataset.pushData({
                            url: url,
                            email: cleanEmail,
                            foundOn: new Date().toISOString()
                        });
                    }
                }
                
                // Only enqueue links if we haven't reached the limit
                if (pagesProcessed < maxRequestsPerCrawl) {
                    await enqueueLinks({
                        strategy: 'same-domain',
                        limit: 10, // Limit links per page
                        transformRequestFunction: (req) => {
                            // Skip if we've hit our page limit
                            if (pagesProcessed >= maxRequestsPerCrawl) return false;
                            
                            // Skip non-http URLs
                            if (!req.url.startsWith('http')) return false;
                            
                            // Skip files and media
                            const skipExtensions = /\.(jpg|jpeg|png|gif|svg|webp|mp4|mp3|pdf|zip|rar|doc|docx|xls|xlsx|ppt|pptx|css|js|ico|xml|json)$/i;
                            if (skipExtensions.test(req.url)) return false;
                            
                            // Skip if already processed
                            if (processedUrls.has(req.url)) return false;
                            
                            // Prioritize pages likely to have contact info
                            const priorityPaths = /\/(contact|about|team|staff|people|connect|reach|email)/i;
                            if (priorityPaths.test(req.url)) {
                                req.priority = 10;
                            }
                            
                            return req;
                        }
                    });
                }
                
            } catch (error) {
                console.error(`Error processing ${request.url}: ${error.message}`);
                // Don't throw - continue with other pages
            }
        },
        
        // Handle failures gracefully
        failedRequestHandler({ request, error }) {
            console.log(`Failed to process ${request.url}: ${error.message}`);
            // Don't retry failed requests when we have limited pages
            request.noRetry = true;
        },
        
        // Additional error handling
        errorHandler({ error, request }) {
            console.log(`Error handler triggered for ${request?.url}: ${error.message}`);
        }
    });

    // Start the crawl with error handling
    try {
        await crawler.run([startUrl]);
    } catch (error) {
        console.log(`Crawler finished with error: ${error.message}`);
    }
    
    // Final results
    console.log(`\nScrape complete!`);
    console.log(`Pages processed: ${pagesProcessed}`);
    console.log(`Unique emails found: ${uniqueEmails.size}`);
    
    // Push final summary
    if (uniqueEmails.size > 0) {
        await Actor.pushData({
            summary: {
                totalEmails: uniqueEmails.size,
                emails: [...uniqueEmails],
                pagesScraped: pagesProcessed,
                startUrl: startUrl,
                timestamp: new Date().toISOString()
            }
        });
    }
});