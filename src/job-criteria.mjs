export const EMPLOYER_LABEL = /^(?:招聘主体|招聘公司|雇主|用人单位|Employer)\s*[:：]\s*/iu;
const CONTRACT_LABEL = /^(?:签约主体|合同主体|劳动合同签订方)\s*[:：]\s*/u;
const CONTRACT_GROUP_LABEL = /^(?:签约主体|合同主体)(?:所属集团|归属)\s*[:：]\s*/u;
const GROUP_LABEL = /^(?:招聘主体(?:所属集团|归属)|招聘公司所属集团|雇主所属集团|用人单位所属集团)\s*[:：]\s*/u;
const BASE_LABEL = /^(?:Base(?:城市)?|职位城市|工作城市|城市)\s*[:：]\s*/iu;
const LOCATION_LABEL = /^(?:办公(?:地点|地址|区县)|工作(?:地点|地址|城市)|办公地|所在地|Base(?:城市)?|职位城市|城市|Location)\s*[:：]\s*/iu;
const SALARY_LABEL = /^(?:(?:税前)?月薪|薪[资酬](?:范围|待遇)?|待遇|年薪|日薪|时薪|Salary|Pay)\s*[:：]\s*/iu;
const HANGZHOU_DISTRICTS = [
  '余杭区', '西湖区', '上城区', '拱墅区', '滨江区', '萧山区', '临平区', '钱塘区', '富阳区', '临安区', '桐庐县', '淳安县', '建德市',
];
const ALLOWED_DISTRICTS = new Set(['余杭区', '西湖区']);
const CITY_NAMES = ['杭州', '上海', '北京', '深圳', '广州', '宁波', '南京', '苏州', '成都', '武汉', '南昌', '香港'];
const locationSeparator = /\s*[·、/|,;]\s*/u;
const missingLocation = /^(?:待确认|待确定|待定|未披露|未明确|未知|保密|不限|不详|全国|多地|远程|面议|同上)$/u;

// 仅匹配招聘主体字段中的完整名称。各分组按集团自披露资料维护。
const EMPLOYER_GROUPS = [
  {
    names: ['阿里巴巴', '阿里巴巴集团', '阿里巴巴集团控股有限公司', 'Alibaba', 'Alibaba Group',
      '淘宝', '天猫', '阿里云', '高德', '飞猪', '盒马', '阿里健康'],
    source: 'https://www.alibabagroup.com/en-US/about/businesses',
  },
  {
    names: ['阿里巴巴(中国)有限公司'],
    source: 'https://www.alibabacloud.com/en/whois/%E9%98%BF%E9%87%8C%E5%B7%B4%E5%B7%B4.%E4%B8%AD%E5%9B%BD',
  },
  {
    names: ['杭州阿里巴巴广告有限公司', '淘宝中国控股有限公司', '浙江淘宝网络有限公司', '浙江天猫网络有限公司'],
    source: 'https://ipp.alibabagroup.com/agreement.htm',
  },
  {
    names: ['阿里云计算有限公司'],
    source: 'https://www.alibabacloud.com/help/zh/oos/support/oos-terms-of-service',
  },
  {
    names: ['高德软件有限公司', '北京高德图强科技有限公司'],
    source: 'https://developer.amap.com/pages/terms/',
  },
  {
    names: ['平头哥半导体有限公司'],
    source: 'https://data.alibabagroup.com/ecms-files/1532295521/e48e70a1-e5c8-40ac-bdd2-951ebcb36946/Alibaba%20Group%20Announces%20December%20Quarter%202025%20Results.pdf',
  },
  {
    names: ['字节跳动', '字节跳动集团', 'ByteDance', '抖音', '今日头条', '飞书', '豆包', '火山引擎', 'TikTok', '剪映', 'PICO'],
    source: 'https://www.bytedance.com/products-services',
  },
  {
    names: ['北京字节跳动科技有限公司'],
    source: 'https://www.samr.gov.cn/xw/zj/art/2023/art_39631d2ab7314f678bca2b5a0441b667.html',
  },
  {
    names: ['北京抖音信息服务有限公司'],
    source: 'https://supplier.bytedance.com/supplier/template/documents/default-USER_PROTOCOL_MESSAGE-en.html',
  },
  {
    names: ['北京字节跳动网络技术有限公司'],
    source: 'https://contest.bytedance.com/privacy-policy',
  },
  {
    names: ['北京春田知韵科技有限公司'],
    source: 'https://seed.bytedance.com/zh/privacy-policy',
  },
  {
    names: ['北京火山引擎科技有限公司'],
    source: 'https://docs.volcengine.com/docs/legal-agreements/products-and-services-agreement?lang=zh',
  },
];
const EMPLOYER_EXCEPTIONS = new Set([
  '蚂蚁', '蚂蚁集团', '蚂蚁科技集团股份有限公司', 'ant group', '菜鸟', '菜鸟集团', '菜鸟网络',
  '菜鸟网络科技有限公司', '浙江菜鸟供应链管理有限公司', 'cainiao',
]);
const EXCLUDED_GROUPS = new Set(['阿里巴巴', '阿里巴巴集团', 'alibaba', 'alibaba group', '字节跳动', '字节跳动集团', 'bytedance']);

const normalize = text => text.normalize('NFKC').trim();
const key = text => normalize(text).toLowerCase().replace(/\s+/gu, ' ');
const unique = values => [...new Set(values.filter(Boolean))];

// 招聘主体发布职位；有独立签约主体时，后者只参与雇主筛选。
function employerNames(lines, label) {
  return unique(lines.map(line => line.replace(label, '').trim()))
    .filter(name => !/^(?:待确认|未披露|保密|未知|外包|代招|第三方)$/u.test(name)
      && !/[(（](?:外包|代招|驻场)[)）]$/u.test(name));
}

export function namedRecruiters(metadata) {
  return employerNames(metadata.filter(line => EMPLOYER_LABEL.test(line)), EMPLOYER_LABEL);
}

export function verifiedJobFacts(metadata, { city, district, salaryQuote } = {}) {
  // 签约主体明确时以劳动合同主体为准，避免把驻场客户当作雇主。
  const contractLines = metadata.filter(line => CONTRACT_LABEL.test(line));
  const recruiterLines = metadata.filter(line => EMPLOYER_LABEL.test(line));
  const employerLines = contractLines.length ? contractLines : recruiterLines;
  const employerLabel = contractLines.length ? CONTRACT_LABEL : EMPLOYER_LABEL;
  const employers = employerNames(employerLines, employerLabel);
  const contractGroups = metadata.filter(line => CONTRACT_GROUP_LABEL.test(line));
  const distinctContract = contractLines.length && recruiterLines.some(line =>
    !employers.some(employer => key(employer) === key(line.replace(EMPLOYER_LABEL, ''))));
  const groups = contractGroups.length || distinctContract
    ? contractGroups.map(line => line.replace(CONTRACT_GROUP_LABEL, '').trim())
    : metadata.filter(line => GROUP_LABEL.test(line)).map(line => line.replace(GROUP_LABEL, '').trim());
  // 标签或紧邻职位标题的独立地点行才是地点证据，客户描述不参与判断。
  const bareCity = city ? key(city).replace(/市$/u, '') : '';
  const locations = metadata.filter(line => {
    if (LOCATION_LABEL.test(line)) return true;
    const address = key(line);
    if (district && address === key(district)) return true;
    if (!bareCity) return false;
    const parts = address.split(locationSeparator).map(part => part.replace(/市$/u, ''));
    return parts.includes(bareCity) && parts.every(part => CITY_NAMES.includes(part) || part === bareCity)
      || Boolean(district && address === bareCity + key(district));
  });
  const salaries = metadata.filter(line => SALARY_LABEL.test(line));
  if (salaryQuote && !salaries.some(line => normalize(line).includes(normalize(salaryQuote)))) {
    // 薪资原文可能单独占一行。必须包含明确周期或常见月薪区间记法。
    const standalone = metadata.find(line => normalize(line) === normalize(salaryQuote));
    if (standalone && (/^\s*(?:人民币\s*|[¥￥]\s*)?\d/u.test(standalone) || /月薪|年薪/u.test(standalone))) {
      salaries.push(standalone);
    }
  }
  return { employers, groups, locations, salaries, employerEvidence: employers.length === 1 ? employerLines[0] : null };
}

function addressParts(value, explicitBase, cityNames) {
  const address = value.replace(/^(?:[\p{Script=Han}]{2,8}?省\s*|浙江\s*(?=杭州))/u, '');
  const initialDistrict = HANGZHOU_DISTRICTS.find(district => address.startsWith(district))
    ?? (/^(?:余杭|西湖)$/u.test(address) ? `${address}区` : null);
  if (initialDistrict) return { city: initialDistrict === '余杭区' ? '杭州' : null, district: initialDistrict };

  // 只读取行政区划前缀，地址尾部的公司、学校和园区名称不参与城市判断。
  const cityWithSuffix = /^([\p{Script=Han}]{2,8}?)市(?!场)/u.exec(address);
  const knownCity = cityNames.find(city => {
    if (!address.startsWith(city)) return false;
    const suffix = address.slice(city.length);
    if (!suffix || /^(?:市(?!场)|\s|余杭|西湖)/u.test(suffix)) return true;
    const subdivision = /^[\p{Script=Han}]{1,8}?(?:区|县)(?!划)/u.exec(suffix)?.[0];
    return subdivision && !/大学|学院|校区|园区|小区|社区|景区/u.test(subdivision);
  });
  const bareCity = explicitBase && /^[\p{Script=Han}]{2,8}$/u.test(address)
    && !missingLocation.test(address) && !/[区县省]$/u.test(address) ? address : null;
  const englishCity = /^hangzhou\b/u.exec(address);
  const city = knownCity ?? cityWithSuffix?.[1] ?? (englishCity ? '杭州' : bareCity);
  const remainder = address.slice((englishCity?.[0] ?? city ?? '').length).replace(/^市?\s*/u, '');
  const district = HANGZHOU_DISTRICTS.find(name => remainder.startsWith(name))
    ?? (/^(?:余杭$|yuhang\b)/u.test(remainder) ? '余杭区' : null)
    ?? (/^(?:西湖$|xihu\b)/u.test(remainder) ? '西湖区' : null);
  return { city: city ?? (district === '余杭区' ? '杭州' : null), district };
}

function withoutBaseAnnotations(location) {
  // 行末标点不属于地名。删除紧跟在 Base 地名后的成对括号，包含嵌套括号。
  const value = location.replace(/[。.!?]+$/u, '').trimEnd();
  let depth = 0;
  let start = 0;
  let keptFrom = 0;
  let result = '';
  for (const match of value.matchAll(/[()]/gu)) {
    const index = match.index;
    if (match[0] === '(') {
      if (depth === 0) start = index;
      depth++;
      continue;
    }
    if (depth === 0) continue;
    depth--;
    if (depth === 0 && /^\s*(?:[·、/|,;]|$)/u.test(value.slice(index + 1))) {
      result += value.slice(keptFrom, start);
      keptFrom = index + 1;
    }
  }
  return result + value.slice(keptFrom);
}

function checkLocation(job, pending, excluded) {
  const locationLines = job.facts?.locations ?? unique([job.cityEvidence, job.districtEvidence, job.city]);
  const baseCities = new Set();
  const officeCities = new Set();
  const districts = new Set();
  const observedCities = (job.observedCities ?? [job.city]).filter(Boolean)
    .map(city => key(city).replace(/市$/u, ''))
    .filter(city => /^[\p{Script=Han}]{2,8}$/u.test(city) && !missingLocation.test(city));
  const cityNames = [...CITY_NAMES, ...observedCities];
  const hasBase = locationLines.some(line => BASE_LABEL.test(line));
  for (const line of locationLines) {
    const explicitBase = BASE_LABEL.test(line);
    const location = key(line.replace(LOCATION_LABEL, ''));
    // Base 城市后的括号只限定 Base，括号里的区县和分隔符不参与办公地址判断。
    const value = explicitBase ? withoutBaseAnnotations(location) : location;
    for (const part of value.split(locationSeparator)) {
      const { city, district } = addressParts(part.trim(), explicitBase, cityNames);
      if (city) (explicitBase ? baseCities : officeCities).add(city);
      if (district && !explicitBase) districts.add(district);
    }
  }
  // 有明确 Base 时以该字段为准，旧 JD 只写地点时仍可从办公城市推断。
  const cities = hasBase ? baseCities : officeCities;
  if (cities.size > 1) pending.push('Base 信息有冲突，待确认');
  else if (!cities.size) pending.push('杭州 Base 待确认');
  else if (!cities.has('杭州')) excluded.push('Base 不在杭州');

  if (officeCities.size > 1 || districts.size > 1) pending.push('办公地点信息有冲突，待确认');
  else if ((officeCities.size && !officeCities.has('杭州'))
    || (districts.size && !ALLOWED_DISTRICTS.has([...districts][0]))) excluded.push('办公地点不在余杭区或西湖区');
  else if (!districts.size || !officeCities.size) pending.push('办公地点待确认');
}

function parseSalary(line) {
  const text = normalize(line).replace(/^\s*(?:人民币|CNY|RMB)?\s*[¥￥]?\s*/iu, '');
  if (/港币|港元|美元|美金|欧元|英镑|新加坡元|日元|USD|HKD|EUR|SGD|JPY|GBP|[$€£]|年薪|日薪|时薪|(?:\/|每)(?:年|天|小时)|\b(?:yearly|annually|hourly|daily)\b|\/\s*(?:year|day|hour)\b/iu.test(text)) {
    return 'unsupported';
  }
  const value = text.replace(SALARY_LABEL, '').replace(/^(?:税前\s*)?(?:人民币|CNY|RMB)?\s*[¥￥]?\s*/iu, '');
  const range = /^(\d+(?:\.\d+)?)\s*([kK万千元])?\s*(?:[-–—~〜至到]\s*(\d+(?:\.\d+)?)\s*([kK万千元])?)?\s*(?:元)?\s*((?:\/\s*(?:月|mo(?:nth)?)|每月))?\s*(?:(?:[·x×*]\s*)?\d+\s*薪)?\s*$/iu.exec(value);
  if (!range) return null;
  const [, lower, lowerUnit, upper, upperUnit, period] = range;
  const units = { k: 1000, 万: 10_000, 千: 1000, 元: 1 };
  const amount = (number, unit, otherUnit) => Number(number) * (units[(unit ?? (Number(number) < 1000 ? otherUnit : null))?.toLowerCase()] ?? 1);
  // 招聘薪资字段中的 k、千或万区间按常见人民币月薪记法解析，明示的外币或其他周期优先。
  if (!period && !/(?:月薪|每月)/u.test(text) && !(upper && /[kK万千]/u.test((lowerUnit ?? '') + (upperUnit ?? '')))) return null;
  const minimum = amount(lower, lowerUnit, upperUnit);
  const maximum = upper ? amount(upper, upperUnit, lowerUnit) : minimum;
  return Number.isFinite(minimum) && Number.isFinite(maximum) && minimum <= maximum ? [minimum, maximum] : null;
}

function checkSalary(job, pending, excluded) {
  const observations = job.facts?.salaries ?? unique([job.salaryQuote]);
  const ranges = unique(observations.map(line => JSON.stringify(parseSalary(line))));
  if (ranges.length > 1) pending.push('月薪信息有冲突，待确认');
  else if (ranges[0] === '"unsupported"') excluded.push('标注薪资的币种或周期不符合人民币月薪条件');
  else if (!ranges.length || ranges[0] === 'null') pending.push('人民币月薪待确认');
  else {
    const [minimum, maximum] = JSON.parse(ranges[0]);
    if (minimum < 30_000 || minimum > 50_000 || maximum < 30_000) excluded.push('人民币月薪区间不符合条件');
  }
}

function checkEmployer(job, pending, excluded) {
  const employers = unique((job.facts?.employers ?? unique([job.employer])).map(key));
  const groups = unique((job.facts?.groups ?? []).map(key));
  if (!employers.length || employers.length > 1 || groups.length > 1) {
    pending.push(employers.length > 1 || groups.length > 1 ? '招聘主体信息有冲突，待确认' : '招聘主体待确认');
    return undefined;
  }
  const [employer] = employers;
  const [group] = groups;
  if (EMPLOYER_EXCEPTIONS.has(employer) || EMPLOYER_EXCEPTIONS.has(group)) return undefined;
  const affiliation = EMPLOYER_GROUPS.find(item => item.names.some(name => key(name) === employer));
  if (affiliation || EXCLUDED_GROUPS.has(group)) {
    excluded.push('招聘主体属于排除范围');
    return affiliation?.source;
  }
  return undefined;
}

export function screenHardConditions(job) {
  const pending = [];
  const excluded = [];
  checkLocation(job, pending, excluded);
  checkSalary(job, pending, excluded);
  const employerSource = checkEmployer(job, pending, excluded);
  return { pending, excluded, employerSource };
}
