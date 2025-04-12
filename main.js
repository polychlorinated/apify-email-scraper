import { Actor } from 'apify';
import { PuppeteerCrawler } from 'crawlee';
import * as cheerio from 'cheerio';

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/gi;

// Use environment variables for configuration
const maxConcurrency = parseInt(process.env.MAX_CONCURRENCY || '10', 10);
const maxRequestsPerCrawl = parseInt(process.env.MAX_REQUESTS_PER_CRAWL || '1000', 10);
const headless = process.env.HEADLESS !== 'false';
const timeout = parseInt(process.env.TIMEOUT || '30000', 10);
const requestDelay = parseInt(process.env.REQUEST_DELAY || '500', 10);

await Actor.main(async () => {
    const input = await Actor.getInput();
    const startUrl = input?.url;

    // Validate input
    if (!startUrl || !startUrl.startsWith('http')) {
        throw new Error('Valid URL required');
    }

    const dataset = await Actor.openDataset();
    const uniqueEmails = new Set();
    const baseUrl = new URL(startUrl);

    console.log('Starting email scraper with configuration:');
    console.log(`URL: ${startUrl}`);
    console.log(`Max Concurrency: ${maxConcurrency}`);
    console.log(`Max Requests: ${maxRequestsPerCrawl}`);
    console.log(`Headless: ${headless}`);
    console.log(`Timeout: ${timeout}ms`);
    console.log(`Request Delay: ${requestDelay}ms`);

    const crawler = new PuppeteerCrawler({
        // Configuration for Puppeteer
        maxConcurrency,
        maxRequestsPerCrawl,
        navigationTimeoutSecs: Math.ceil(timeout / 1000),
        browserPoolOptions: {
            puppeteerOptions: {
                headless,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            }
        },
        // Handle each page crawled
        async requestHandler({ request, page, enqueueLinks }) {
            try {
                // Add delay between requests if configured
                if (requestDelay > 0) {
                    await new Promise(resolve => setTimeout(resolve, requestDelay));
                }

                console.log(`Processing ${request.url}`);
                
                // Wait for page content
                await page.waitForSelector('body', { timeout });
                const html = await page.content();
                const $ = cheerio.load(html);
                
                // Extract emails from page text
                const text = $('body').text();
                const emails = text.match(EMAIL_REGEX) || [];
                console.log(`Found ${emails.length} emails on ${request.url}`);
                
                // Store unique emails
                for (const email of emails) {
                    const cleanEmail = email.toLowerCase();
                    if (!uniqueEmails.has(cleanEmail)) {
                        uniqueEmails.add(cleanEmail);
                        await dataset.pushData({
                            url: request.url,
                            email: cleanEmail
                        });
                    }
                }

                // Find and queue all same-domain links
                await enqueueLinks({
                    strategy: 'same-domain',
                    transformRequestFunction: (req) => {
                        // Skip non-http URLs and file downloads
                        if (!req.url.startsWith('http')) return false;
                        // Skip common file extensions that won't contain emails
                        if (/\.(jpg|jpeg|png|gif|svg|webp|mp4|mp3|pdf|zip|rar|doc|docx|xls|xlsx|ppt|pptx)$/i.test(req.url)) {
                            return false;
                        }
                        return req;
                    }
                });
            } catch (error) {
                console.error(`Error processing ${request.url}: ${error.message}`);
            }
        },
        // Handle request failures
        failedRequestHandler({ request, error }) {
            console.error(`Request failed: ${request.url}`, error);
        }
    });

    // Start the crawl
    await crawler.run([startUrl]);
    
    // Final statistics
    console.log(`Scrape complete. Found ${uniqueEmails.size} unique emails.`);
    await Actor.pushData([...uniqueEmails].map(email => ({ email })));
});