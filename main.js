const Apify = require('apify');
const cheerio = require('cheerio');
const { URL } = require('url');

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/gi;

Apify.main(async () => {
    const input = await Apify.getInput();
    const startUrl = input.url;

    if (!startUrl || !startUrl.startsWith('http')) {
        throw new Error('Please provide a valid URL as input');
    }

    const dataset = await Apify.openDataset();
    const uniqueEmails = new Set();

    // Use PuppeteerCrawler for JS rendering
    const crawler = new Apify.PuppeteerCrawler({
        requestList: await Apify.openRequestList('start-urls', [startUrl]),
        
        // Puppeteer launch options
        launchContext: {
            launchOptions: {
                headless: true,
                useChrome: false, // Use Chromium instead of full Chrome
            }
        },

        handlePageFunction: async ({ request, page, response }) => {
            // Use Puppeteer to render page
            await page.waitForNetworkIdle({ idleTime: 500 });
            const html = await page.content();
            
            // Use Cheerio for parsing
            const $ = cheerio.load(html);
            
            // Extract emails
            const text = $('body').text();
            const emails = text.match(EMAIL_REGEX) || [];

            // Process emails
            if (emails.length > 0) {
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
            }

            // Find links with Cheerio
            const baseUrl = new URL(startUrl);
            $('a').each((i, el) => {
                const href = $(el).attr('href');
                try {
                    const url = new URL(href, baseUrl.origin);
                    if (url.hostname === baseUrl.hostname) {
                        crawler.requestQueue.addRequest({
                            url: href,
                            userData: {
                                referer: request.url
                            }
                        });
                    }
                } catch (error) {
                    // Ignore invalid URLs
                }
            });
        },

        handleFailedRequestFunction: async ({ request }) => {
            console.log(`Request ${request.url} failed`);
        }
    });

    await crawler.run();
    console.log(`Found ${uniqueEmails.size} unique email addresses`);
    await Apify.pushData([...uniqueEmails].map(email => ({ email })));
});