import fs from 'fs';
import sh from 'shorthash';
import path from 'path';
import moment from 'moment';
import pkginfo from 'pkginfo';
import program from 'commander';
import puppeteer from 'puppeteer';

const info = pkginfo(module, 'version');

const defaultOutputFile = `./nubank-${moment().add(1, 'months').format('YYYY-MM')}.ofx`;

program
    .version(info.version)
    .option('--include-id', 'Include an unique ID in each transaction description.')
    .option('-u, --username <str>', 'Username. Required.')
    .option('-p, --password <str>', 'Password. Required.')
    .option('-t, --timeout <int>', 'Timeout, in seconds, while waiting for pages to load. Defaults to 10.')
    .option('-o, --output <path>', `Output file. Defaults to ${defaultOutputFile}`)
    .parse(process.argv);

if (!program.username || !program.password) {
    console.error('Please, provide a --username and a --password');
    process.exit(1);
}

const outputPath = (
    program.output
        ? path.join(process.cwd(), program.output)
        : defaultOutputFile
);

const configuredTimeout = (
    program.timeout
        ? program.timeout * 1000
        : 10000
);

puppeteer.launch({headless: true})
    .then(async browser => {
        try {
            const page = await browser.newPage();

            console.log('Logging in...');

            await login(page, program.username, program.password);

            console.log('Fetching bill...');

            return await fetchLastBill(page);
        } finally {
            await browser.close();
        }
    })
    .then(bill => {
        console.log('Generating OFX...');
        return generateOfx(bill.line_items, {includeUid: !!program.includeId});
    })
    .then((ofx) => writeToFile(ofx, outputPath))
    .then(() => console.log(`Done! OFX file saved to ${outputPath}.`));


const baseUrl = 'https://conta.nubank.com.br';

const navigationConfig = {
    timeout: configuredTimeout,
    waitUntil: 'networkidle',
    networkIdleTimeout: 5000,
};

async function login(page, username, password) {
    await page.goto(baseUrl, navigationConfig);

    await page.waitForSelector('#username', {visible: true, timeout: configuredTimeout});
    await page.waitForSelector('form input[type="password"]', {visible: true, timeout: configuredTimeout});

    const usernameInput = await page.$('#username');
    await usernameInput.focus();
    await usernameInput.type(username, {delay: 100});

    const passwordInput = await page.$('form input[type="password"]');
    await passwordInput.focus();
    await passwordInput.type(password, {delay: 100});

    const submit = await page.$('form button[type="submit"]');

    // XXX Why do we use all here? Couldn't we use two awaits?
    await Promise.all([
        page.waitForNavigation(navigationConfig),
        submit.click(),
    ]);

    const billsButtonSelector = 'li a.menu-item.bills';

    await page.waitForSelector(billsButtonSelector, {timeout: configuredTimeout});

    return true;
}

async function fetchLastBill(page) {
    const [bill, _ignoredResult] = await Promise.all([
        waitForBillData(page),
        page.goto(`${baseUrl}/#/bills`, navigationConfig),
    ]);
    return bill;
}

function waitForBillData(page) {
    return new Promise((resolve, reject) => {
        const onResponse = response => {
            const contentType = response.headers['content-type'];
            if ((contentType || '').startsWith('application/json')) {
                return response.json().then(body => {
                    if (body && body.bill && body.bill.state === 'open') {
                        resolve(body.bill);
                    }
                    return response;
                });
            }
            return response;
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

function writeToFile(s, path) {
    return new Promise((resolve, reject) => {
        fs.writeFile(path, s, err => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

function generateOfx(charges, {timezoneOffset = 180, includeUid = false} = {}) {
    const tz = (timezoneOffset / 60) * (-1);

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
${charges.map(({id, title, amount, post_date: date}) => {
    const memo = (
        !includeUid ? title : `#${sh.unique(id)} - ${title}`
    );
    return `
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>${moment(date).format('YYYYMMDD')}000000[${tz}:GMT]
<TRNAMT>${((-1) * amount / 100).toFixed(2)}
<FITID>${id}</FITID>
<MEMO>${memo}</MEMO>
</STMTTRN>
`}).join('\n')}
</BANKTRANLIST>

</CCSTMTRS>
</CCSTMTTRNRS>
</CREDITCARDMSGSRSV1>
</OFX>
`;
}
