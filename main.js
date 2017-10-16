import fs from 'fs';
import path from 'path';
import moment from 'moment';
import pkginfo from 'pkginfo';
import program from 'commander';
import * as webdriver from 'selenium-webdriver';
import * as chromeDriver from 'selenium-webdriver/chrome';

const info = pkginfo(module, 'version');

const defaultOutputFile = `./nubank-${moment().add(1, 'months').format('YYYY-MM')}.ofx`;

program
    .version(info.version)
    .option('-u, --username <str>', 'Username. Required.')
    .option('-p, --password <str>', 'Password. Required.')
    .option('-c, --chrome-path <path>', 'Chrome binary path')
    .option('-t, --timeout <int>', 'Timeout, in seconds, while waiting for pages to load. Defaults to 10.')
    .option('-o, --output <path>', `Output file. Defaults to ${defaultOutputFile}`)
    .parse(process.argv);

if (!program.username || !program.password) {
    console.error('Please, provide a --username and a --password');
    process.exit(1);
}

const options = new chromeDriver.Options()
    .headless()
    .windowSize({width: 1200, height: 600})
    .setChromeBinaryPath(program.chromePath);

const driver = new webdriver.Builder()
    .forBrowser('chrome')
    .setChromeOptions(options)
    .build();

const {By, until} = webdriver;
const waitTimeout = (program.timeout || 10) * 1000;

const outputPath = (
    program.output
        ? path.join(process.cwd(), program.output)
        : defaultOutputFile
);

driver
    .then(() => console.log('Accessing...'))
    .then(() => driver.get('https://conta.nubank.com.br/'))
    .then(() => waitElementReady(By.id('username')))
    .then(() => driver.wait(until.elementLocated(By.css('div#loaderDiv')), waitTimeout))
    .then(loader => driver.wait(until.elementIsNotVisible(loader), waitTimeout))
    .then(() => console.log('Logging in...'))
    .then(() => driver.findElement(By.id('username')))
    .then(input => input.sendKeys(program.username))
    .then(() => driver.findElement(By.css('form input[type="password"]')).sendKeys(program.password))
    .then(() => driver.findElement(By.css('form button[type="submit"]')).click())
    .then(() => driver.wait(until.titleContains('Histórico'), waitTimeout))
    .then(() => driver.wait(until.elementLocated(By.css('div#loaderDiv')), waitTimeout))
    .then(loader => driver.wait(until.elementIsNotVisible(loader), waitTimeout))
    .then(() => console.log('Loading bills...'))
    .then(() => driver.findElement(By.css('li a.menu-item.bills')).click())
    .then(() => driver.wait(until.elementLocated(By.css('div#loaderDiv')), waitTimeout))
    .then(loader => driver.wait(until.elementIsNotVisible(loader), waitTimeout * 4))
    .then(() => driver.findElement(By.xpath("//div[@class='md-header-items']/md-tab[last()]")).click())
    .then(() => console.log('Parsing charges...'))
    .then(() => driver.findElements(By.css('div.charges-list div.charge')))
    .then(charges => charges.map(parseCharge))
    .then(charges => Promise.all(charges))
    .then(charges => {
        console.log('Generating ofx...');
        return charges;
    })
    .then(charges => {
        const locale = driver.executeScript('return window.navigator.userLanguage || window.navigator.language;');
        const timezoneOffset = driver.executeScript('return new Date().getTimezoneOffset();');
        return Promise.all([Promise.resolve(charges), locale, timezoneOffset]);
    })
    .then(([charges, locale, timezoneOffset]) => generateOfx(charges, {locale, timezoneOffset}))
    .then(ofx => writeToFile(ofx, outputPath))
    .then(() => console.log(`Done! OFX file saved to ${outputPath}`))
    .catch(err => {
        console.log(err);
        return {error: err};
    })
    .then(({error} = {}) => driver.quit().then(() => process.exit(error ? 1 : 0)));

function waitElementReady(by, timeout = waitTimeout, retry = 0) {
    return driver.findElement(by)
        .catch(err => {
            if (retry <= 3) {
                if (err instanceof webdriver.error.NoSuchElementError) {
                    return driver.wait(until.elementLocated(by), timeout)
                        .then(el => waitElementReady(by, timeout, retry + 1));
                } else if (err instanceof webdriver.error.ElementNotVisibleError) {
                    return driver.wait(until.elementIsVisible(by), timeout)
                        .then(el => waitElementReady(by, timeout, retry + 1));
                }
            }
            throw err;
        })
        .then(el => driver.wait(until.elementIsVisible(el, timeout)));
}

function parseCharge(el) {
    const date = el.findElement(By.css('div.time')).getText();
    const desc = el.findElement(By.css('div.charge-data div.description')).getText();
    const amount = el.findElement(By.css('div.charge-data div.amount')).getText();
    return Promise.all([date, desc, amount])
        .then(([date, desc, amount]) => ({date, desc, amount}));
}

function writeToFile(s, path) {
    return new Promise((resolve, reject) => {
        fs.writeFile(path, s, err => {
            if (err) {
                reject(err);
            } else {
                resolve(err);
            }
        });
    });
}

function generateOfx(charges, {locale, timezoneOffset}) {
    const tz = (timezoneOffset / 60) * (-1);

    // XXX NuBank ignores browser locale, uses pt-BR
    moment.locale('pt-BR');

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
${charges.map(c => {
        const type = c.amount.indexOf('-') !== 0 ? 'DEBIT' : 'CREDIT';
        const amount = `${type === 'DEBIT' ? '-' : ''}${c.amount.replace(/^-/, '').replace(/,/g, '.')}`;
        return `
<STMTTRN>
<TRNTYPE>${type}
<DTPOSTED>${moment(c.date, 'DD MMM').year(moment().year()).format('YYYYMMDD')}000000[${tz}:GMT]
<TRNAMT>${amount}
<MEMO>${c.desc}
</STMTTRN>
`}).join('\n')}
</BANKTRANLIST>

</CCSTMTRS>
</CCSTMTTRNRS>
</CREDITCARDMSGSRSV1>
</OFX>
`;
}
