// File: services/geolocationService.js
// Geolocation service untuk mendapatkan info lokasi user berdasarkan IP

import logger from '../utils/logger.js';

class GeolocationService {
    constructor() {
        this.cache = new Map();
        this.cacheExpiry = 24 * 60 * 60 * 1000; // 24 hours
        this.ipwhoisUrl = 'https://ipwhois.app/json/';
    }

    async getUserGeolocation(userContext) {
        try {
            // Extract IP from context
            let userIp = null;
            
            if (userContext.from?.ip_address) {
                userIp = userContext.from.ip_address;
            } else if (userContext.ip_address) {
                userIp = userContext.ip_address;
            }

            // If no IP in context, we can't get geolocation
            if (!userIp) {
                logger.debug('No IP address found in user context');
                return null;
            }

            // Check cache first
            const cached = this.getFromCache(userIp);
            if (cached) {
                logger.debug(`Geolocation cache hit for IP: ${userIp}`);
                return cached;
            }

            // Fetch from ipwhois
            const geoData = await this.fetchGeoLocation(userIp);
            
            if (geoData) {
                this.cache.set(userIp, {
                    data: geoData,
                    timestamp: Date.now()
                });
                return geoData;
            }

            return null;
        } catch (error) {
            logger.error(`Geolocation fetch error: ${error.message}`);
            return null;
        }
    }

    async fetchGeoLocation(ip) {
        try {
            const response = await fetch(this.ipwhoisUrl, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                }
            });

            if (!response.ok) {
                logger.warn(`ipwhois API returned status ${response.status}`);
                return null;
            }

            const data = await response.json();

            if (data.success) {
                return {
                    ip: data.ip,
                    country: data.country,
                    countryCode: data.country_code,
                    region: data.region,
                    city: data.city,
                    timezone: data.timezone_name || data.timezone,
                    continent: data.continent,
                    latitude: data.latitude,
                    longitude: data.longitude,
                    isp: data.isp,
                    org: data.org
                };
            }

            return null;
        } catch (error) {
            logger.error(`ipwhois fetch error: ${error.message}`);
            return null;
        }
    }

    getFromCache(ip) {
        const cached = this.cache.get(ip);
        
        if (cached) {
            const age = Date.now() - cached.timestamp;
            if (age < this.cacheExpiry) {
                return cached.data;
            } else {
                this.cache.delete(ip);
            }
        }

        return null;
    }

    formatGeolocation(geoData) {
        if (!geoData) return null;

        const parts = [];

        if (geoData.city && geoData.region) {
            parts.push(`${geoData.city}, ${geoData.region}`);
        } else if (geoData.city) {
            parts.push(geoData.city);
        } else if (geoData.region) {
            parts.push(geoData.region);
        }

        if (geoData.country) {
            parts.push(geoData.country);
        }

        if (geoData.timezone) {
            parts.push(`(${geoData.timezone})`);
        }

        return parts.join(' • ');
    }

    formatGeolocationDetailed(geoData) {
        if (!geoData) return null;

        let text = '🌍 <b>Lokasi:</b>\n';
        
        if (geoData.city) {
            text += `📍 Kota: <b>${geoData.city}</b>\n`;
        }
        
        if (geoData.region) {
            text += `🏘️ Region: <b>${geoData.region}</b>\n`;
        }
        
        if (geoData.country) {
            text += `🌐 Negara: <b>${geoData.country}</b>`;
            if (geoData.countryCode) {
                text += ` (${geoData.countryCode})`;
            }
            text += '\n';
        }
        
        if (geoData.timezone) {
            text += `🕐 Timezone: <b>${geoData.timezone}</b>\n`;
        }

        if (geoData.isp) {
            text += `🔗 ISP: <b>${geoData.isp}</b>\n`;
        }

        return text.trim();
    }

    clearCache() {
        this.cache.clear();
        logger.info('Geolocation cache cleared');
    }

    getCacheStats() {
        return {
            cacheSize: this.cache.size,
            cacheExpiry: this.cacheExpiry
        };
    }
}

export default new GeolocationService();
