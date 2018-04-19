import fs from 'fs';
import sh from 'shorthash';
import pTry from 'p-try';
import yargs from 'yargs';
import moment from 'moment';
import chrono from 'chrono-node';
import inquirer from 'inquirer';
import puppeteer from 'puppeteer';
import objectHash from 'object-hash';

function handleError({extra}, error) {
    if (error instanceof Error && !extra.includes('traceback')) {
        error = error.message;
    }
    console.error(error);
    return (error && error.exitCode) || 1;
}

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
            type: 'string',
            alias: 'p',
            description: 'Password. Set it to a minus sign (-) to be prompted',
            demandOption: true,
        })
        .option('timeout', {
            type: 'number',
            alias: 't',
            default: 30,
            description: 'Navigation timeout (in seconds)',
        })
        .option('since', {
            type: 'string',
            alias: 's',
            default: 'open',
            description: (
                'Since when you want to export '
                + '(can be a date or one of "now", '
                + '"today", "last week", "last month" '
                + 'or something like that)'
            ),
        })
        .option('until', {
            type: 'string',
            alias: 'e',
            default: 'now',
            description: (
                'Up until when you want to export '
                + '(can be a date or one of "now", '
                + '"today", "last week", "last month" '
                + 'or something like that)'
            ),
        })
        .option('output', {
            alias: 'o',
            default: null,
            normalize: true,
            description: 'Output file',
            defaultDescription: './nubank-(hash).ofx',
        })
        .option('json', {
            type: 'boolean',
            alias: 'j',
            default: false,
            description: 'Export as JSON. Changes default output to ./nubank-(hash).json',
        })
        .option('detailed', {
            type: 'boolean',
            alias: 'd',
            default: false,
            description: 'Include detailed information',
        })
        .option('extra', {
            type: 'x',
            array: true,
            hidden: true,
            default: [],
            description: 'Extra, undocumented options',
        }),

    handler: (argv) => (
        pTry(() => main(argv))
            .catch(handleError.bind(null, argv))
            .then(exitCode => exitCode || 0)
            .then(process.exit)
    ),
};

void (
    yargs.command(mainCommand)
        .help()
        .version()
        .argv
);

async function main(options) {
    const {
        json,
        extra,
        since,
        until,
        output: requestedOutputPath,
        timeout: timeoutInSeconds,
        detailed,
        username,
        password: givenPassword,
    } = options;

    const password = (
        givenPassword !== '-' || extra.includes('no-input')
            ? givenPassword
            : await askForPassword(username)
    );

    const timeout = timeoutInSeconds * 1000;

    const headless = !extra.includes('headful');

    const {bills, timezoneOffset} =
        await fetchBillsAndTimezoneOffset({
            timeout,
            headless,
            username,
            password,
        });

    const fileFormat = (json ? 'json' : 'ofx');

    const fileFormatUpper = fileFormat.toUpperCase();

    console.log(`Generating ${fileFormatUpper}...`);

    const charges = bills
        .reduce((charges, bill) => charges.concat(
            bill.line_items.map(i =>
                asCharge(i, bill.state, timezoneOffset, detailed))
            ),
            []
        )
        .filter(charge => isBetween(
            charge.date.date, since, until, charge.billState
        ));

    const output = (
        json ? JSON.stringify(charges, null, 2)
            : generateOfx(charges, detailed)
    );

    const outputPath = (
        requestedOutputPath !== null
            ? requestedOutputPath
            : defaultOutputPath(bills, fileFormat)
    );

    await writeToFile(output, outputPath);

    console.log(`${fileFormatUpper} file saved to ${outputPath}!`);

    return 0;
}

async function askForPassword(username) {
    const {password} = await inquirer.prompt([{
        type: 'password',
        name: 'password',
        message: `Please enter a password for user "${username}"`,
    }]);
    return password;
}

async function fetchBillsAndTimezoneOffset({username, password, timeout, headless}) {
    const browser = await puppeteer.launch({headless});
    try {
        const page = await browser.newPage();

        page.setDefaultNavigationTimeout(timeout);

        console.log('Logging in...');

        const result = await login(page, username, password, timeout);
        if (result.error) {
            throw new Error(`Login failed: ${result.error}`);
        }

        console.log('Fetching bills...');

        const bills = await fetchBills(page, timeout);

        const timezoneOffset = await page.evaluate(() => new Date().getTimezoneOffset());

        return {bills, timezoneOffset};
    } finally {
        await browser.close();
    }
}

// FIXME: This is stupidly unoptimized: we're parsing sinceDate and untilDate
// for each item, and we're mixing both dates and 'forever', 'open', etc.
// Maybe we could have a factory that takes the static 'since' and 'until' and
// returns a comparator that can be used as a filter.
function isBetween(dt, since, until, billState) {
    if (since === 'forever' && until === 'forever') {
        return true;
    } else if (since === 'open' && billState === 'open') {
        return isBetween(dt, 'forever', until, billState);
    } else {
        const sinceDate = parseDate(since);
        const untilDate = parseDate(until);
        return moment(dt).isBetween(sinceDate, untilDate);
    }
}

function parseDate(text) {
    try {
        return moment(text);
    } catch (e) {
        const dt = chrono.parseDate(text);
        return moment(dt);
    }
}

function defaultOutputPath(bills, format) {
    const name = objectHash(bills);
    return `./nubank-${sh.unique(name)}.${format}`;
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

    if (result === null) {
        result = {
            error: 'Please verify your username and password'
        };
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

function asCharge(itemData, billState, timezoneOffset, detailed) {
    const {
        id,
        title,
        amount,
        post_date: date,
    } = itemData;
    const charge = {
        id,
        date: {date, timezoneOffset},
        title,
        amount: (amount / 100).toFixed(2),
        billState,
    };
    if (detailed) {
        return {...itemData, ...charge};
    } else {
        return charge;
    }
}

function ofxItem(itemData, detailed) {
    const {
        id,
        date: {
            date,
            timezoneOffset
        },
        title,
        amount,
    } = itemData;
    const shortid = sh.unique(id);
    const memo = (
        detailed ? `#${shortid} - ${title}` : title
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

function generateOfx(charges, detailed) {
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
${charges.map(i => ofxItem(i, detailed)).join('\n')}
</BANKTRANLIST>

</CCSTMTRS>
</CCSTMTTRNRS>
</CREDITCARDMSGSRSV1>
</OFX>
`;
}
