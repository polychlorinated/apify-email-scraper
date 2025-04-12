import { Actor } from 'apify';
import cheerio from 'cheerio';
import { URL } from 'url';

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/gi;

await Actor.main(async () => {
    const input = await Actor.getInput();
    const startUrl = input.url;

    if (!startUrl?.startsWith('http')) {
        throw new Error('Valid URL required');
    }

    const dataset = await Actor.openDataset();
    const uniqueEmails = new Set();

    const crawler = new Actor.PuppeteerCrawler({
        requestList: await Actor.openRequestList('start-urls', [startUrl]),
        
        launchContext: {
            launchOptions: {
                headless: "new",
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            }
        },

        async handlePageFunction({ request, page }) {
            await page.waitForNetworkIdle({ idleTime: 500 });
            const html = await page.content();
            const $ = cheerio.load(html);
            
            const text = $('body').text();
            const emails = text.match(EMAIL_REGEX) || [];

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

            const baseUrl = new URL(startUrl);
            $('a').each((i, el) => {
                const href = $(el).attr('href');
                try {
                    const url = new URL(href, baseUrl.origin);
                    if (url.hostname === baseUrl.hostname) {
                        crawler.requestQueue.addRequest({
                            url: href,
                            userData: { referer: request.url }
                        });
                    }
                } catch (_) {}
            });
        },

        handleFailedRequestFunction: ({ request }) => {
            Actor.log.warning(`Failed: ${request.url}`);
        }
    });

    await crawler.run();
    await Actor.pushData([...uniqueEmails].map(email => ({ email })));
    Actor.log.info(`Found ${uniqueEmails.size} emails`);
});