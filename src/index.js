import fs from 'fs';
import sh from 'shorthash';
import pTry from 'p-try';
import yargs from 'yargs';
import moment from 'moment';
import puppeteer from 'puppeteer';

const mainCommand = {
    command: '$0',

    builder: yargs => yargs
        .option('username', {
            type: 'string',
            alias: 'u',
            description: 'Username',
            demandOption: true,
        })
        .option('password', {
            alias: 'p',
            type: 'string',
            description: 'Password',
            demandOption: true,
        })
        .option('timeout', {
            type: 'number',
            alias: 't',
            default: 30,
            description: 'Navigation timeout (in seconds)',
        })
        .option('month', {
            type: 'string',
            alias: 'm',
            default: null,
            description: 'The month you want to export (due date of the bill, format: YYYY-MM). Can also be `all`',
            defaultDescription: 'Currently open bill'
        })
        .option('output', {
            default: null,
            normalize: true,
            description: 'Output file',
            defaultDescription: 'nubank-YYYY-MM.ofx',
        })
        .option('format', {
            type: 'string',
            alias: 'f',
            choices: ['ofx', 'json'],
            default: 'ofx',
            description: 'Output format',
        })
        .option('include-id', {
            type: 'boolean',
            default: false,
            description: 'Include a unique ID in the transaction description',
        })
        .option('headful', {
            type: 'boolean',
            default: false,
            description: (
                'Run the browser in headful mode '
                + '(that is, not headless - '
                + 'useful for development and debugging)'
            ),
        }),

    handler: (argv) => {
        return pTry(() => main(argv))
            .then(
                // onSuccess
                exitCode => process.exit(exitCode || 0),

                // onError
                (err) => {
                    console.error(err);
                    process.exit(1);
                }
            );
    }
};

const argv = (
    yargs.command(mainCommand)
        .help()
        .version()
        .argv
);

async function main({month, timeout, headful, ...argv}) {
    // Validate `month` parameter
    if (month && month !== 'all') {
        const monthString = month;
        moment.suppressDeprecationWarnings = true;
        month = moment(monthString);
        if (!month.isValid()) {
            console.error(`Invalid date format: ${monthString}`);
            return 1;
        }
    }

    // Convert `timeout` to milliseconds
    timeout *= 1000;

    const browser = await puppeteer.launch({headless: !headful});

    let bills, timezoneOffset;
    try {
        const page = await browser.newPage();

        page.setDefaultNavigationTimeout(timeout);

        console.log('Logging in...');

        const loginResult = await login(page, argv.username, argv.password, timeout);
        if (loginResult.error) {
            console.error(`Login failed: ${loginResult.error}`);
            return 1;
        }

        console.log('Fetching bills...');

        bills = await fetchBills(page, timeout);

        timezoneOffset = await page.evaluate(() => new Date().getTimezoneOffset());
    } finally {
        await browser.close();
    }

    if (month === null) {
        bills = bills.filter(bill => bill.state === 'open');
    } else if (month !== 'all') {
        bills = bills.filter(bill => (
            moment(bill.summary.due_date).isSame(month, 'month')
        ));
    }

    const charges = bills.map(bill => bill.line_items)
        .reduce((a, b) => a.concat(b), [])
        .map(i => toItem(i, timezoneOffset));

    console.log(`Generating ${argv.format.toUpperCase()}...`);

    const output = (
        argv.format === 'json'
            ? JSON.stringify(charges, null, 2)
            : generateOfx(charges, !!argv.includeId)
    );

    const outputPath = (
        argv.output !== null
            ? argv.output
            : defaultOutputPath(argv.format, month, bills)
    );

    await writeToFile(output, outputPath);

    console.log(`Done! ${argv.format.toUpperCase()} file saved to ${outputPath}`);

    return 0;
}

function defaultOutputPath(format, month, bills) {
    const name = (
        month === 'all'
            ? 'all'
            : moment(bills[0].summary.due_date).format('YYYY-MM')
    );
    return `./nubank-${name}.${format}`;
}

const baseUrl = 'https://app.nubank.com.br';

async function login(page, username, password, timeout) {
    await page.goto(baseUrl, {timeout, waitFor: 'networkidle0'});

    const usernameInput = await page.waitForSelector('#username', {visible: true, timeout});
    await usernameInput.focus();
    await usernameInput.type(username, {delay: 58});

    const passwordInput = await page.waitForSelector('form input[type="password"]', {visible: true, timeout});
    await passwordInput.focus();
    await passwordInput.type(password, {delay: 58});

    const submit = await page.$('form button[type="submit"]');

    let result = null;
    const onResponse = async (response) => {
        const request = response.request();

        if (request.method() !== 'POST') {
            return;
        }

        let data;
        try {
            data = JSON.parse(request.postData());
        } catch (e) {
            return;
        }

        if (data && data.grant_type && data.password) {
            result = await response.json().catch(() => null);
        }
    };

    page.on('response', onResponse);

    try {
        await Promise.all([
            submit.click(),
            waitForNetworkIdle(page, {globalTimeout: timeout})
        ]);
    } finally {
        page.removeListener('response', onResponse);
    }

    return result;
}

async function fetchBills(page, timeout) {
    const bills = [];

    const onResponse = async (response) => {
        const data = await response.json().catch(() => null);
        if (data && data.bill) {
            bills.push(data.bill);
        }
    };

    page.on('response', onResponse);

    // XXX Going to bills page is problematic, mostly because
    // the issues when using both goto and hash navigation.
    // We circumvent that by:
    //  1. first trying to click the menu item.
    //  2. if thats not possible, then goto about://blank then goto bills page
    //
    // We then rely on `waitForNetworkIdle` to wait for the right moment
    // to continue the flow of the script.
    const goToBillsPage = async () => {
        const url = await page.evaluate('location.href');
        if (url.startsWith(`${baseUrl}/#/`)) {
            try {
                const btn = await page.$('.menu-item.bills');
                return await btn.click();
            } catch (e) {
                console.warn('Clicking the button failed...');
            }
        }
        return await (
            page.goto('about://blank', {waitFor: 'load'})
                .then(async () =>
                    await page.goto(
                        `${baseUrl}/#/bills`,
                        {timeout: timeout * 2}
                    )
                )
        );
    };

    try {
        await Promise.all([
            goToBillsPage(),
            waitForNetworkIdle(page, {globalTimeout: timeout * 2})
        ]);
    } finally {
        page.removeListener('response', onResponse);
    }

    return bills;
}

async function waitForNetworkIdle(page, {timeout = 500, requests = 0, globalTimeout = null} = {}) {
    return await new Promise((resolve, reject) => {
        const deferred = [];
        const cleanup = () => deferred.reverse().forEach(fn => fn());
        const cleanupAndReject = (err) => cleanup() || reject(err);
        const cleanupAndResolve = (val) => cleanup() || resolve(val);

        if (globalTimeout === null) {
            globalTimeout = page._defaultNavigationTimeout;
        }

        const globalTimeoutId = setTimeout(
            cleanupAndReject,
            globalTimeout,
            new Error('Waiting for network idle timed out')
        );

        deferred.push(() => {
            clearTimeout(globalTimeoutId);
        });

        let inFlight = 0;
        let timeoutId = setTimeout(cleanupAndResolve, timeout);

        deferred.push(() => clearTimeout(timeoutId));

        const onRequest = () => {
            ++inFlight;
            if (inFlight > requests) {
                clearTimeout(timeoutId);
            }
        };

        const onResponse = () => {
            if (inFlight === 0) {
                return;
            }
            --inFlight;
            if (inFlight <= requests) {
                timeoutId = setTimeout(cleanupAndResolve, timeout);
            }
        };

        page.on('request', onRequest);
        page.on('requestfailed', onResponse);
        page.on('requestfinished', onResponse);

        deferred.push(() => {
            page.removeListener('request', onRequest);
            page.removeListener('requestfailed', onResponse);
            page.removeListener('requestfinished', onResponse);
        });
    });
}

async function writeToFile(s, path) {
    return await new Promise((resolve, reject) => {
        fs.writeFile(path, s, err => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

function toItem({id, title, amount, post_date: date}, timezoneOffset) {
    const shortid = sh.unique(id);
    return {
        id,
        date: {date, timezoneOffset},
        title,
        amount: (amount / 100).toFixed(2),
        shortid,
    };
}

function ofxItem({id, date: {date, timezoneOffset}, title, amount, shortid}, shouldIncludeUid) {
    const memo = (
        !shouldIncludeUid ? title : `#${shortid} - ${title}`
    );
    return `
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>${moment(date).format('YYYYMMDD')}000000[${timezoneOffset / 60 * -1}:GMT]
<TRNAMT>${amount * -1}
<FITID>${id}</FITID>
<MEMO>${memo}</MEMO>
</STMTTRN>
`;
}

function generateOfx(charges, shouldIncludeUid) {
    return `
OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>

<LANGUAGE>POR
</SONRS>
</SIGNONMSGSRSV1>

<CREDITCARDMSGSRSV1>
<CCSTMTTRNRS>
<TRNUID>1001
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>

<CCSTMTRS>
<CURDEF>BRL
<CCACCTFROM>
<ACCTID>nubank-ofx-preview
</CCACCTFROM>

<BANKTRANLIST>
${charges.map(i => ofxItem(i, shouldIncludeUid)).join('\n')}
</BANKTRANLIST>

</CCSTMTRS>
</CCSTMTTRNRS>
</CREDITCARDMSGSRSV1>
</OFX>
`;
}
