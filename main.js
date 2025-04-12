import { Actor } from 'apify';
import { PuppeteerCrawler } from 'crawlee';
import * as cheerio from 'cheerio';

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/gi;

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

    const crawler = new PuppeteerCrawler({
        // Updated to match Puppeteer 20.x API
        launchOptions: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        },
        async requestHandler({ request, page }) {
            try {
                // Wait for page content
                await page.waitForSelector('body', { timeout: 15000 });
                const html = await page.content();
                const $ = cheerio.load(html);
                
                // Process emails
                const text = $('body').text();
                const emails = text.match(EMAIL_REGEX) || [];
                
                // Use for...of instead of forEach for async
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

                // Process links
                const links = await page.$$eval('a', anchors => 
                    anchors.map(a => a.href)
                );
                
                for (const href of links) {
                    try {
                        const url = new URL(href, baseUrl.origin);
                        if (url.hostname === baseUrl.hostname) {
                            await crawler.addRequests([href]);
                        }
                    } catch (error) {
                        Actor.log.warning(`Invalid URL: ${href}`);
                    }
                }
            } catch (error) {
                Actor.log.error(`Error processing ${request.url}: ${error.message}`);
            }
        },
        failedRequestHandler({ request }) {
            Actor.log.error(`Request failed: ${request.url}`);
        }
    });

    await crawler.run([startUrl]);
    await Actor.pushData([...uniqueEmails].map(email => ({ email })));
    Actor.log.info(`Scrape complete. Found ${uniqueEmails.size} emails.`);
});