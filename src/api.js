import fetch from 'node-fetch';

export default class NuBankApi {
    static baseUrl = 'https://prod-s0-webapp-proxy.nubank.com.br';

    static headers = {
        'Origin': 'https://conta.nubank.com.br',
        'Pragma': 'no-cache',
        'Referer': 'https://conta.nubank.com.br/',
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/66.0.3359.139 Safari/537.36',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'X-Correlation-Id': 'WEB-APP.gLFQL',
    };

    constructor({urls}) {
        this.urls = urls;
    }

    static async discover() {
        const url = `${NuBankApi.baseUrl}/api/discovery`;
        const response = await fetch(url);
        return new NuBankApi({urls: await response.json()});
    }

    async login({username, password}) {
        const body = JSON.stringify({
            login: username,
            password,
            client_id: 'other.conta',
            grant_type: 'password',
            client_secret: 'yQPeLzoHuJzlMMSAjC-LgNUJdUecx8XO',
        });

        const response = await fetch(this.urls.login, {
            body,
            method: 'POST',
            headers: {
                ...NuBankApi.headers,
                'Content-Type': 'application/json;charset=UTF-8',
                'Content-Length': body.length,
            },
        });

        return await response.json();
    }

    async fetch(link, accessToken) {
        const response = await fetch(link, {
            headers: {
                ...NuBankApi.headers,
                Authorization: `Bearer ${accessToken}`,
            },
        });

        return await response.json();
    }
}
