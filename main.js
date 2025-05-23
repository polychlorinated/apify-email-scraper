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
    const urls = input?.urls || (input?.url ? [input.url] : []);

    // Validate input
    if (!urls || urls.length === 0) {
        throw new Error('At least one valid URL required');
    }

    const dataset = await Actor.openDataset();
    const uniqueEmails = new Set();
    const processedUrls = new Set();
    let pagesProcessed = 0;

    console.log('Starting email scraper with optimized configuration:');
    console.log(`URLs to process: ${urls.length}`);
    console.log(`Max Pages per URL: ${maxRequestsPerCrawl}`);
    console.log(`Concurrency: ${maxConcurrency}`);
    console.log(`Timeout: ${timeout}ms`);

    // Process each URL independently
    const results = [];
    
    for (const startUrl of urls) {
        console.log(`\n--- Processing ${startUrl} ---`);
        
        // Validate URL
        if (!startUrl || !startUrl.startsWith('http')) {
            console.log(`Skipping invalid URL: ${startUrl}`);
            results.push({
                url: startUrl,
                status: 'failed',
                error: 'Invalid URL',
                emails: []
            });
            continue;
        }
        
        const urlEmails = new Set();
        const processedUrls = new Set();
        let pagesProcessed = 0;

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
                    if (cleanEmail.includes('@') && cleanEmail.includes('.') && !urlEmails.has(cleanEmail)) {
                        urlEmails.add(cleanEmail);
                        uniqueEmails.add(cleanEmail);
                        await dataset.pushData({
                            url: url,
                            email: cleanEmail,
                            foundOn: new Date().toISOString(),
                            sourceUrl: startUrl
                        });
                    }
                }
                
                // Only enqueue links if we haven't reached the limit
                if (pagesProcessed < 3) {
                    // Get current queue stats
                    const stats = await crawler.requestQueue.getInfo();
                    const remainingSlots = Math.max(0, 3 - stats.handledRequestCount - stats.pendingRequestCount);
                    
                    if (remainingSlots > 0) {
                        await enqueueLinks({
                            strategy: 'same-domain',
                            limit: remainingSlots, // Only enqueue what we can process
                            transformRequestFunction: (req) => {
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
                    } else {
                        console.log('Skipping link enqueuing - page limit reached');
                    }
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
            results.push({
                url: startUrl,
                status: 'success',
                emails: [...urlEmails],
                pagesScraped: pagesProcessed
            });
        } catch (error) {
            console.log(`Crawler finished with error: ${error.message}`);
            results.push({
                url: startUrl,
                status: 'failed',
                error: error.message,
                emails: [...urlEmails],
                pagesScraped: pagesProcessed
            });
        }
        
        console.log(`Completed ${startUrl}: ${urlEmails.size} emails found`);
        
        // Push individual URL result immediately
        await Actor.pushData({
            type: 'url_result',
            url: startUrl,
            emails: [...urlEmails],
            pagesScraped: pagesProcessed,
            timestamp: new Date().toISOString()
        });
    }
    
    // Final results
    console.log(`\n=== FINAL SUMMARY ===`);
    console.log(`Total URLs processed: ${urls.length}`);
    console.log(`Total unique emails found: ${uniqueEmails.size}`);
    
    // Push final summary
    await Actor.pushData({
        type: 'final_summary',
        totalUrls: urls.length,
        totalEmails: uniqueEmails.size,
        results: results,
        allEmails: [...uniqueEmails],
        timestamp: new Date().toISOString()
    });
});