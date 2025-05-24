import { Actor } from 'apify';
import { PuppeteerCrawler } from 'crawlee';
import * as cheerio from 'cheerio';

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/gi;
const FACEBOOK_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:facebook\.com|fb\.com)\/[A-Za-z0-9\.\-_]+\/?/gi;

// Use environment variables for configuration
const maxConcurrency = parseInt(process.env.MAX_CONCURRENCY || '2', 10);
const headless = process.env.HEADLESS !== 'false';
const timeout = parseInt(process.env.TIMEOUT || '15000', 10);

await Actor.main(async () => {
    const input = await Actor.getInput();
    
    // Handle both single URL and array of URLs
    let urls = [];
    if (input?.urls && Array.isArray(input.urls)) {
        urls = input.urls;
    } else if (input?.url) {
        urls = [input.url];
    }

    // Validate input
    if (urls.length === 0) {
        throw new Error('At least one URL required in either "url" or "urls" field');
    }

    const dataset = await Actor.openDataset();

    console.log('Starting homepage scraper');
    console.log(`URLs to process: ${urls.length}`);
    console.log(`Timeout: ${timeout}ms`);

    // Process results
    const results = [];

    const crawler = new PuppeteerCrawler({
        maxConcurrency,
        navigationTimeoutSecs: Math.ceil(timeout / 1000),
        requestHandlerTimeoutSecs: Math.ceil(timeout / 1000) + 10,
        
        // Optimized browser settings
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
                    '--disable-gpu'
                ]
            }
        },
        
        // Configure navigation
        preNavigationHooks: [
            async ({ request }, gotoOptions) => {
                gotoOptions.waitUntil = 'domcontentloaded';
                gotoOptions.timeout = timeout;
            }
        ],
        
        // Handle each homepage
        async requestHandler({ request, page }) {
            const url = request.url;
            console.log(`Processing: ${url}`);
            
            try {
                // Wait for basic content
                try {
                    await page.waitForSelector('body', { timeout: 5000 });
                } catch (e) {
                    console.log('Body not found quickly, proceeding anyway...');
                }
                
                // Extract emails using multiple methods
                const emails = new Set();
                
                // Method 1: Get from page text
                try {
                    const textContent = await page.evaluate(() => document.body.innerText || document.body.textContent || '');
                    const textEmails = textContent.match(EMAIL_REGEX) || [];
                    textEmails.forEach(email => emails.add(email.toLowerCase()));
                } catch (e) {
                    console.log('Error getting text content:', e.message);
                }
                
                // Method 2: Get from HTML
                try {
                    const html = await page.content();
                    const $ = cheerio.load(html);
                    const htmlText = $.text();
                    const htmlEmails = htmlText.match(EMAIL_REGEX) || [];
                    htmlEmails.forEach(email => emails.add(email.toLowerCase()));
                } catch (e) {
                    console.log('Error parsing HTML:', e.message);
                }
                
                // Method 3: Look for mailto links
                try {
                    const mailtoEmails = await page.evaluate(() => {
                        const links = Array.from(document.querySelectorAll('a[href^="mailto:"]'));
                        return links.map(link => link.href.replace('mailto:', '').split('?')[0]);
                    });
                    mailtoEmails.forEach(email => emails.add(email.toLowerCase()));
                } catch (e) {
                    console.log('Error finding mailto links:', e.message);
                }
                
                // Extract Facebook URLs
                const facebookUrls = new Set();
                
                // Method 1: Look for Facebook links in href attributes
                try {
                    const fbLinks = await page.evaluate(() => {
                        const links = Array.from(document.querySelectorAll('a[href*="facebook.com"], a[href*="fb.com"]'));
                        return links.map(link => link.href);
                    });
                    fbLinks.forEach(fbUrl => {
                        // Clean up Facebook URL
                        if (fbUrl && (fbUrl.includes('facebook.com') || fbUrl.includes('fb.com'))) {
                            // Remove tracking parameters
                            const cleanUrl = fbUrl.split('?')[0].split('#')[0];
                            facebookUrls.add(cleanUrl);
                        }
                    });
                } catch (e) {
                    console.log('Error finding Facebook links:', e.message);
                }
                
                // Method 2: Search for Facebook URLs in text/HTML
                try {
                    const html = await page.content();
                    const fbMatches = html.match(FACEBOOK_REGEX) || [];
                    fbMatches.forEach(fbUrl => {
                        // Ensure it starts with https://
                        let cleanUrl = fbUrl;
                        if (!cleanUrl.startsWith('http')) {
                            cleanUrl = 'https://' + cleanUrl;
                        }
                        cleanUrl = cleanUrl.split('?')[0].split('#')[0];
                        facebookUrls.add(cleanUrl);
                    });
                } catch (e) {
                    console.log('Error searching for Facebook URLs:', e.message);
                }
                
                // Filter out invalid emails
                const validEmails = Array.from(emails).filter(email => {
                    return email.includes('@') && 
                           email.includes('.') && 
                           !email.includes('example.com') &&
                           !email.includes('your-email') &&
                           !email.includes('@email.com') &&
                           email.length < 100; // Avoid parsing errors
                });
                
                // Get the most relevant Facebook URL (prefer company pages)
                const fbUrlArray = Array.from(facebookUrls);
                const primaryFacebookUrl = fbUrlArray.find(url => 
                    !url.includes('/sharer') && 
                    !url.includes('/share') &&
                    !url.includes('/plugins')
                ) || fbUrlArray[0] || null;
                
                console.log(`Found ${validEmails.length} emails and ${fbUrlArray.length} Facebook URLs`);
                
                // Create result
                const result = {
                    url: url,
                    emails: validEmails,
                    email: validEmails[0] || null, // Primary email
                    facebookUrl: primaryFacebookUrl,
                    allFacebookUrls: fbUrlArray,
                    timestamp: new Date().toISOString(),
                    success: true
                };
                
                results.push(result);
                await dataset.pushData(result);
                
            } catch (error) {
                console.error(`Error processing ${url}: ${error.message}`);
                
                const errorResult = {
                    url: url,
                    emails: [],
                    email: null,
                    facebookUrl: null,
                    allFacebookUrls: [],
                    error: error.message,
                    timestamp: new Date().toISOString(),
                    success: false
                };
                
                results.push(errorResult);
                await dataset.pushData(errorResult);
            }
        },
        
        // Handle failures
        failedRequestHandler({ request, error }) {
            console.log(`Failed to process ${request.url}: ${error.message}`);
            
            const errorResult = {
                url: request.url,
                emails: [],
                email: null,
                facebookUrl: null,
                allFacebookUrls: [],
                error: error.message,
                timestamp: new Date().toISOString(),
                success: false
            };
            
            results.push(errorResult);
            dataset.pushData(errorResult).catch(e => console.error('Failed to push error result:', e));
        }
    });

    // Process all URLs
    try {
        await crawler.run(urls);
    } catch (error) {
        console.log(`Crawler error: ${error.message}`);
    }
    
    // Summary
    console.log(`\n=== SCRAPING COMPLETE ===`);
    console.log(`Total URLs processed: ${results.length}`);
    console.log(`Successful: ${results.filter(r => r.success).length}`);
    console.log(`Failed: ${results.filter(r => !r.success).length}`);
    
    // Push summary
    const summary = {
        type: 'summary',
        totalUrls: results.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        results: results,
        timestamp: new Date().toISOString()
    };
    
    await dataset.pushData(summary);
});