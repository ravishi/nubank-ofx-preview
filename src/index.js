import fs from 'fs';
import sh from 'shorthash';
import pTry from 'p-try';
import yargs from 'yargs';
import moment from 'moment';
import puppeteer from 'puppeteer';

const mainCommand = {
    builder: yargs => yargs
        .option('format', {
            type: 'string',
            alias: 'f',
            choices: ['ofx', 'json'],
            default: 'ofx',
            description: 'Output format',
        })
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
            description: 'Request timeout in seconds',
        })
        .option('output', {
            default: null,
            description: 'Output file',
            defaultDescription: 'nubank-YYYY-MM.ofx',
            normalize: true,
        })
        .option('include-id', {
            type: 'boolean',
            default: false,
            description: 'Include a unique ID in the transaction description',
        })
    ,

    command: '$0',

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

const _ = (
    yargs.command(mainCommand)
        .help()
        .version()
        .argv
);

async function main(argv) {
    if (argv.output === null) {
        argv.output = `./nubank-${moment().add(1, 'months').format('YYYY-MM')}.${argv.format}`;
    }

    const timeout = argv.timeout * 1000;

    const browser = await puppeteer.launch({headless: false});

    let bill, timezoneOffset;
    try {
        const page = await browser.newPage();

        page.setDefaultNavigationTimeout(timeout);

        console.log('Logging in...');

        await login(page, argv.username, argv.password, timeout);

        console.log('Fetching bill...');

        bill = await fetchLastBill(page);

        timezoneOffset = await page.evaluate(() => new Date().getTimezoneOffset());
    } finally {
        await browser.close();
    }

    const charges = bill.line_items.map(i => toItem(i, timezoneOffset));

    console.log(`Generating ${argv.format.toUpperCase()}...`);

    const output = (
        argv.format === 'json'
            ? JSON.stringify(charges, null, 2)
            : generateOfx(charges, !!argv.includeId)
    );

    await writeToFile(output, argv.output);

    console.log(`Done! ${argv.format.toUpperCase()} file saved to ${argv.output}.`);

    return 0;
}

const baseUrl = 'https://conta.nubank.com.br';

async function login(page, username, password, timeout) {
    await page.goto(baseUrl, {waitUntil: 'networkidle0'});

    await page.waitForSelector('#username', {visible: true, timeout});
    await page.waitForSelector('form input[type="password"]', {visible: true, timeout});

    const usernameInput = await page.$('#username');
    await usernameInput.focus();
    await usernameInput.type(username, {delay: 100});

    const passwordInput = await page.$('form input[type="password"]');
    await passwordInput.focus();
    await passwordInput.type(password, {delay: 100});

    const submit = await page.$('form button[type="submit"]');

    // TODO: Create some kind of waitForNetworkIdle function and use it here.
    // See: - https://github.com/GoogleChrome/puppeteer/issues/1412
    //      - https://github.com/GoogleChrome/puppeteer/issues/1608
    //
    await submit.click();

    // XXX For now, we are clicking and waiting for a selector. But that's pretty volatile, if you ask me.
    const billsButtonSelector = 'li a.menu-item.bills';
    await page.waitForSelector(billsButtonSelector, {timeout});

    return true;
}

async function fetchLastBill(page) {
    // XXX We go to blank, then back to bills page in order to be able to wait for 'load'
    // TODO In the future, we should have a waitForNetworkIdle kind of function to be used here.
    await page.goto('about:blank', {waitUntil: 'load'});

    const [bill, _] = await Promise.all([
        waitForBillData(page),
        page.goto(`${baseUrl}/#/bills`, {waitUntil: 'load'}),
    ]);

    return bill;
}

async function waitForBillData(page) {
    // TODO Maybe we could introduce a timeout here?
    // TODO Maybe we could turn this into a helper, which receives a
    // "filter/mapper" and either returns from that filter or times out
    // if the filter doesnt pass.
    return await new Promise((resolve, reject) => {
        const onResponse = response => {
            response.json().catch(() => null).then(data => {
                if (data && data.bill && data.bill.state === 'open') {
                    resolve(data.bill);
                }
            });
        };

        const onError = error => {
            page.off('error', onError);
            page.off('response', onResponse);
            reject(error);
        };

        page.on('error', onError);
        page.on('response', onResponse);
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
