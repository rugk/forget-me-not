/**
 * License: zlib/libpng
 * @author Santo Pfingsten
 * @see https://github.com/Lusito/forget-me-not
 */

import { settings } from "../lib/settings";
import { removeCookie, cleanLocalStorage } from "./backgroundShared";
import { TabWatcher } from "./tabWatcher";
import { browser, Cookies } from "webextension-polyfill-ts";
import { isFirefox, browserInfo } from "../lib/browserInfo";
import { getFirstPartyCookieDomain } from "./backgroundHelpers";
import { RuleType } from "../lib/settingsSignature";

// fixme: make this file unit-testable and add tests

export class CleanStore {
    private readonly tabWatcher: TabWatcher;
    private readonly id: string;
    private domainRemoveTimeouts: { [s: string]: number } = {};
    private snoozing: boolean;
    private readonly snoozedDomainLeaves: { [s: string]: boolean } = {};

    public constructor(id: string, tabWatcher: TabWatcher, snoozing: boolean) {
        this.id = id;
        this.tabWatcher = tabWatcher;
        this.snoozing = snoozing;
    }

    private cleanCookiesByDomain(domain: string, ignoreRules: boolean) {
        this.removeCookies((cookie) => {
            const allowSubDomains = cookie.domain.startsWith('.');
            const match = allowSubDomains ? (domain.endsWith(cookie.domain) || cookie.domain.substr(1) === domain) : (cookie.domain === domain);
            return match && (ignoreRules || !this.isCookieAllowed(cookie, false, true));
        });
    }

    public cleanCookiesWithRulesNow(ignoreGrayList: boolean, protectOpenDomains: boolean) {
        this.removeCookies((cookie) => !this.isCookieAllowed(cookie, ignoreGrayList, protectOpenDomains));
    }

    private removeCookies(test: (cookie: Cookies.Cookie) => boolean) {
        const details: Cookies.GetAllDetailsType = { storeId: this.id };
        if (isFirefox && browserInfo.versionAsNumber >= 59)
            details.firstPartyDomain = null;
        browser.cookies.getAll(details).then((cookies) => {
            for (const cookie of cookies) {
                if (test(cookie))
                    removeCookie(cookie);
            }
        });
    }

    private cleanByDomainWithRulesNow(domain: string) {
        if (settings.get('domainLeave.enabled')) {
            if (settings.get('domainLeave.cookies'))
                this.cleanCookiesByDomain(domain, false);

            if (settings.get('domainLeave.localStorage') && !this.isLocalStorageProtected(domain))
                cleanLocalStorage([domain], this.id);
        }
    }

    private isLocalStorageProtected(domain: string): boolean {
        if (this.tabWatcher.cookieStoreContainsDomain(this.id, domain))
            return true;
        const type = settings.getRuleTypeForDomain(domain);
        return type === RuleType.WHITE || type === RuleType.GRAY;
    }

    public isCookieAllowed(cookie: Cookies.Cookie, ignoreGrayList: boolean, protectOpenDomains: boolean) {
        const allowSubDomains = cookie.domain.startsWith('.');
        const rawDomain = allowSubDomains ? cookie.domain.substr(1) : cookie.domain;
        const type = settings.getRuleTypeForCookie(rawDomain, cookie.name);
        if (type === RuleType.WHITE || (type === RuleType.GRAY && !ignoreGrayList))
            return true;
        if (type === RuleType.BLOCK || !protectOpenDomains)
            return false;
        if (cookie.firstPartyDomain)
            return this.tabWatcher.isFirstPartyDomainOnCookieStore(this.id, cookie.firstPartyDomain);
        const firstPartyDomain = getFirstPartyCookieDomain(cookie.domain);
        return this.tabWatcher.isFirstPartyDomainOnCookieStore(this.id, firstPartyDomain);
    }

    public cleanUrlNow(hostname: string) {
        cleanLocalStorage([hostname], this.id);
        this.cleanCookiesByDomain(hostname, true);
    }

    public onDomainLeave(removedDomain: string) {
        if (this.domainRemoveTimeouts[removedDomain]) {
            clearTimeout(this.domainRemoveTimeouts[removedDomain]);
            delete this.domainRemoveTimeouts[removedDomain];
        }
        if (this.snoozing) {
            this.snoozedDomainLeaves[removedDomain] = true;
            return;
        }
        const timeout = settings.get('domainLeave.delay') * 60 * 1000;
        if (timeout <= 0) {
            this.cleanByDomainWithRulesNow(removedDomain);
        } else {
            this.domainRemoveTimeouts[removedDomain] = setTimeout(() => {
                if (this.snoozing)
                    this.snoozedDomainLeaves[removedDomain] = true;
                else
                    this.cleanByDomainWithRulesNow(removedDomain);
                delete this.domainRemoveTimeouts[removedDomain];
            }, timeout);
        }
    }

    public setSnoozing(snoozing: boolean) {
        this.snoozing = snoozing;
        if (snoozing) {
            // cancel countdowns and remember them for later
            for (const domain in this.domainRemoveTimeouts) {
                this.snoozedDomainLeaves[domain] = true;
                clearTimeout(this.domainRemoveTimeouts[domain]);
                delete this.domainRemoveTimeouts[domain];
            }
        } else {
            // reschedule
            for (const domain in this.snoozedDomainLeaves) {
                this.onDomainLeave(domain);
                delete this.snoozedDomainLeaves[domain];
            }
        }
    }
}
