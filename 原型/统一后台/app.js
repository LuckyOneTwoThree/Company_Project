/**
 * IM开放服务 - 统一后台（权限化）
 * 一套完整菜单，通过权限控制可见性
 * 运营视角：产品切换 + 产品内配置
 */

// ========== 权限模型 ==========

const PERMISSIONS = {
  global: { key: 'global', label: '全局管理' },
  operate: { key: 'operate', label: '运营操作' },
  operateRead: { key: 'operateRead', label: '运营查看' },
  config: { key: 'config', label: '配置管理' },
  audit: { key: 'audit', label: '审计日志' }
};

// 全局菜单（不受产品切换影响）
const GLOBAL_MENUS = [
  {
    group: '全局管理',
    perm: 'global',
    items: [
      { key: 'services', label: '服务管理', icon: '🌐' },
      { key: 'chains', label: '链合约管理', icon: '🔗' },
      { key: 'products', label: '产品管理', icon: '📦' },
      { key: 'system', label: '系统配置', icon: '🖥️' },
      { key: 'permission', label: '权限管理', icon: '🔐' }
    ]
  },
  {
    group: '审计日志',
    perm: 'audit',
    items: [
      { key: 'audit', label: '操作审计', icon: '📜' }
    ]
  }
];

// 产品内菜单（随产品切换展示对应数据）
const PRODUCT_MENUS = [
  {
    group: '运营中心',
    perm: 'operate',
    items: [
      { key: 'overview', label: '数据概览', icon: '📊' },
      { key: 'member', label: '会员服务', icon: '🏅' },
      { key: 'airdrop', label: '激励空投', icon: '🎁' },
      { key: 'shop', label: '硬件商城', icon: '📱' },
      { key: 'users', label: '用户管理', icon: '👥' },
      { key: 'reports', label: '运营报表', icon: '📈' }
    ]
  },
  {
    group: '产品配置',
    perm: 'config',
    items: [
      { key: 'serviceConfig', label: '服务配置', icon: '⚙️' },
      { key: 'chainConfig', label: '链合约配置', icon: '🔗' },
      { key: 'bizConfig', label: '业务参数', icon: '📋' }
    ]
  }
];

const ALL_MENUS = [...GLOBAL_MENUS, ...PRODUCT_MENUS];

const ROLES = {
  admin: {
    key: 'admin',
    name: '超级管理员',
    desc: '开发总部',
    icon: '👑',
    perms: ['global', 'operate', 'operateRead', 'config', 'audit'],
    products: ['A', 'B', 'C']
  },
  operator: {
    key: 'operator',
    name: '产品运营',
    desc: '运营组织',
    icon: '💼',
    perms: ['operate', 'operateRead', 'config'],
    products: ['A', 'C']
  }
};

// ========== 状态 ==========

const state = {
  currentUser: null,
  currentPage: 'login',
  currentView: null,
  selectedRole: 'admin',
  currentProduct: null,

  products: [
    { id: 'A', name: 'IM产品A', desc: '企业即时通讯', icon: '💼', color: '#2563eb', services: ['member', 'airdrop', 'shop'], chains: ['chain-x', 'chain-y'] },
    { id: 'B', name: 'IM产品B', desc: '社交聊天工具', icon: '💬', color: '#059669', services: ['member', 'shop'], chains: ['chain-z'] },
    { id: 'C', name: 'IM产品C', desc: '加密通讯平台', icon: '🔐', color: '#7c3aed', services: ['member', 'airdrop', 'shop', 'wallet'], chains: ['chain-x', 'chain-z'] }
  ],
  services: [
    { key: 'member', name: '会员服务', icon: '🏅', desc: '会员订阅与管理', status: 'active', chainMode: 'optional', chains: ['chain-x','chain-y','chain-z'], contractTypes: ['token'], triggerMode: 'active', cronJobs: [], requireLogin: true, requireWallet: false, dependencies: [], callbackUrl: '/api/callback/member', rateLimit: '100/min', dataScope: 'product' },
    { key: 'airdrop', name: '激励空投', icon: '🎁', desc: '代币空投与持仓返利', status: 'active', chainMode: 'required', chains: ['chain-x','chain-y','chain-z'], contractTypes: ['token','airdrop'], triggerMode: 'both', cronJobs: [{name:'持仓快照',schedule:'0 0 * * *',type:'passive',desc:'每日零点快照'},{name:'活动状态切换',schedule:'*/5 * * * *',type:'passive',desc:'每5分钟检查'},{name:'空投领取',schedule:'',type:'active',desc:'用户主动领取'}], requireLogin: true, requireWallet: true, dependencies: ['wallet'], callbackUrl: '/api/callback/airdrop', rateLimit: '30/min', dataScope: 'product' },
    { key: 'shop', name: '硬件商城', icon: '📱', desc: '硬件商品销售', status: 'active', chainMode: 'optional', chains: ['chain-x','chain-z'], contractTypes: ['token'], triggerMode: 'active', cronJobs: [], requireLogin: true, requireWallet: false, dependencies: ['member'], callbackUrl: '/api/callback/shop', rateLimit: '60/min', dataScope: 'product' },
    { key: 'wallet', name: '钱包服务', icon: '💰', desc: '钱包绑定与管理', status: 'active', chainMode: 'required', chains: ['chain-x','chain-y','chain-z'], contractTypes: [], triggerMode: 'active', cronJobs: [], requireLogin: true, requireWallet: false, dependencies: [], callbackUrl: '/api/callback/wallet', rateLimit: '20/min', dataScope: 'global' }
  ],
  chains: [
    { id: 'chain-x', name: '链X', chainId: '0x1', rpc: 'https://rpc.chainx.io', gasToken: 'CX', status: 'active', products: ['A','C'] },
    { id: 'chain-y', name: '链Y', chainId: '0x2', rpc: 'https://rpc.chainy.io', gasToken: 'CY', status: 'active', products: ['A'] },
    { id: 'chain-z', name: '链Z', chainId: '0x3', rpc: 'https://rpc.chainz.io', gasToken: 'CZ', status: 'active', products: ['B','C'] }
  ],
  contracts: [
    { id: 'c1', chainId: 'chain-x', productId: 'A', type: 'token', address: '0x1234...5678', symbol: 'TOKEN', decimals: 18 },
    { id: 'c2', chainId: 'chain-x', productId: 'A', type: 'airdrop', address: '0xabcd...efgh', symbol: '', decimals: 0 },
    { id: 'c3', chainId: 'chain-y', productId: 'A', type: 'token', address: '0x9876...5432', symbol: 'TOKEN2', decimals: 18 },
    { id: 'c4', chainId: 'chain-z', productId: 'B', type: 'token', address: '0xdef0...1234', symbol: 'TOKEN3', decimals: 18 },
    { id: 'c5', chainId: 'chain-x', productId: 'C', type: 'token', address: '0x5555...6666', symbol: 'TOKEN', decimals: 18 },
    { id: 'c6', chainId: 'chain-z', productId: 'C', type: 'airdrop', address: '0x7777...8888', symbol: '', decimals: 0 }
  ],
  auditLogs: [
    { time: '2026-05-21 14:32:18', user: 'admin', action: '修改合约地址', module: '链合约管理', product: '产品A', detail: '链X 代币合约 0x1234...5678' },
    { time: '2026-05-21 13:15:42', user: 'operator1', action: '启用服务', module: '产品管理', product: '产品A', detail: '启用 激励空投' },
    { time: '2026-05-21 11:08:33', user: 'admin', action: '添加链', module: '链合约管理', product: '产品B', detail: '链Z https://rpc.chainz.io' }
  ],
  instances: [
    { id: 'inst-a', productId: 'A', name: '产品A实例', host: '10.0.1.10:8080', version: 'v1.2.0', status: 'running', uptime: '15天3小时', cpu: '23%', memory: '61%', lastDeploy: '2026-05-06 09:00' },
    { id: 'inst-b', productId: 'B', name: '产品B实例', host: '10.0.1.11:8080', version: 'v1.2.0', status: 'running', uptime: '15天3小时', cpu: '18%', memory: '54%', lastDeploy: '2026-05-06 09:00' },
    { id: 'inst-c', productId: 'C', name: '产品C实例', host: '10.0.1.12:8080', version: 'v1.1.8', status: 'running', uptime: '8天12小时', cpu: '31%', memory: '67%', lastDeploy: '2026-05-13 14:30' }
  ],
  gatewayRoutes: [
    { productId: 'A', domain: 'a-api.im-service.io', upstream: '10.0.1.10:8080', ssl: true, rateLimit: '1000/min' },
    { productId: 'B', domain: 'b-api.im-service.io', upstream: '10.0.1.11:8080', ssl: true, rateLimit: '1000/min' },
    { productId: 'C', domain: 'c-api.im-service.io', upstream: '10.0.1.12:8080', ssl: true, rateLimit: '500/min' }
  ],
  databases: [
    { id: 'db-a', name: '业务库A', type: 'PostgreSQL', host: '10.0.2.10:5432', database: 'im_product_a', productId: 'A', status: 'connected', connPool: '20/50' },
    { id: 'db-b', name: '业务库B', type: 'PostgreSQL', host: '10.0.2.11:5432', database: 'im_product_b', productId: 'B', status: 'connected', connPool: '15/50' },
    { id: 'db-c', name: '业务库C', type: 'PostgreSQL', host: '10.0.2.12:5432', database: 'im_product_c', productId: 'C', status: 'connected', connPool: '22/50' },
    { id: 'db-user', name: '公共用户库', type: 'PostgreSQL', host: '10.0.2.20:5432', database: 'im_user_shared', productId: null, status: 'connected', connPool: '35/100' }
  ],
  cacheConfig: { host: '10.0.3.10:6379', maxMemory: '4GB', policies: [
    { key: '产品服务列表', ttl: '5分钟', updateStrategy: '配置变更时主动刷新' },
    { key: '合约参数', ttl: '10分钟', updateStrategy: '变更时主动刷新' },
    { key: '业务参数', ttl: '5分钟', updateStrategy: '变更时主动刷新' },
    { key: '用户权益', ttl: '不缓存', updateStrategy: '实时查询' },
    { key: '审计日志', ttl: '不缓存', updateStrategy: '实时写入' }
  ]},
  authConfig: { jwtExpire: '24h', jwtAlgorithm: 'HS256', ipWhitelist: ['10.0.0.0/8','172.16.0.0/12','192.168.1.0/24'], loginFailLock: 5, lockDuration: '30分钟', twoFactor: false },
  cronJobs: [
    { id: 'j1', name: '持仓快照', schedule: '每日 00:00', status: 'active', lastRun: '2026-05-21 00:00:12', nextRun: '2026-05-22 00:00:00', productId: 'A' },
    { id: 'j2', name: '持仓快照', schedule: '每日 00:00', status: 'active', lastRun: '2026-05-21 00:00:08', nextRun: '2026-05-22 00:00:00', productId: 'C' },
    { id: 'j3', name: '空投活动状态切换', schedule: '每5分钟', status: 'active', lastRun: '2026-05-21 14:30:00', nextRun: '2026-05-21 14:35:00', productId: null },
    { id: 'j4', name: '缓存预热', schedule: '每日 06:00', status: 'active', lastRun: '2026-05-21 06:00:05', nextRun: '2026-05-22 06:00:00', productId: null },
    { id: 'j5', name: '持仓返利计算', schedule: '每周一 02:00', status: 'paused', lastRun: '2026-05-19 02:00:15', nextRun: '-', productId: 'A' }
  ],
  adminAccounts: [
    { id: 'acc-1', username: 'admin', displayName: '超级管理员', role: 'admin', roleName: '超级管理员', products: ['A','B','C'], productNames: ['IM产品A','IM产品B','IM产品C'], status: 'active', lastLogin: '2026-05-21 14:32:18', createdAt: '2026-01-01 09:00:00', creator: 'system' },
    { id: 'acc-2', username: 'operator_a', displayName: '运营A', role: 'operator', roleName: '产品运营', products: ['A','C'], productNames: ['IM产品A','IM产品C'], status: 'active', lastLogin: '2026-05-21 13:15:42', createdAt: '2026-03-15 10:30:00', creator: 'admin' },
    { id: 'acc-3', username: 'operator_b', displayName: '运营B', role: 'operator', roleName: '产品运营', products: ['B'], productNames: ['IM产品B'], status: 'active', lastLogin: '2026-05-20 16:45:10', createdAt: '2026-04-01 14:00:00', creator: 'admin' },
    { id: 'acc-4', username: 'operator_c', displayName: '运营C', role: 'operator', roleName: '产品运营', products: ['A','B','C'], productNames: ['IM产品A','IM产品B','IM产品C'], status: 'disabled', lastLogin: '2026-05-10 09:20:00', createdAt: '2026-04-10 11:00:00', creator: 'admin' }
  ],

  stats: {
    A: { totalUsers: 85432, activeUsers: 23120, memberCount: 5234, memberRate: '6.13%', airdropClaimed: 3456, airdropTotal: 6000, shopOrders: 890, shopRevenue: '¥890,000', walletBound: 3210 },
    B: { totalUsers: 23124, activeUsers: 8901, memberCount: 2100, memberRate: '9.08%', airdropClaimed: 0, airdropTotal: 0, shopOrders: 234, shopRevenue: '¥234,500', walletBound: 890 },
    C: { totalUsers: 19900, activeUsers: 2500, memberCount: 1598, memberRate: '8.03%', airdropClaimed: 2222, airdropTotal: 4000, shopOrders: 110, shopRevenue: '¥110,000', walletBound: 467 }
  },
  dailyData: {
    A: [120,150,130,180,170,210,200,250,230,280,270,310,290,340,320,380,360,410,390,450,430,480,460,510,490,540,520,580,560,610],
    B: [80,90,85,100,95,110,105,120,115,130,125,140,135,150,145,160,155,170,165,180,175,190,185,200,195,210,205,220,215,230],
    C: [120,210,165,240,225,290,275,350,305,400,385,470,435,460,425,480,465,510,495,550,515,580,545,630,595,650,625,680,645,720]
  },
  airdropCampaigns: {
    A: [
      { id: 'ac1', name: '新用户注册奖励', type: 'token_drop', token: 'TOKEN', total: '60,000', claimed: '34,560', claimRate: '57.60%', status: 'active', startDate: '2026-05-01', endDate: '2026-06-01' },
      { id: 'ac2', name: '持仓Gas返利', type: 'holding_reward', token: 'CX', total: '30,000', claimed: '8,200', claimRate: '27.33%', status: 'active', startDate: '2026-05-15', endDate: '2026-06-15' }
    ],
    B: [],
    C: [
      { id: 'ac4', name: '新用户注册奖励', type: 'token_drop', token: 'TOKEN', total: '40,000', claimed: '22,220', claimRate: '55.55%', status: 'active', startDate: '2026-05-01', endDate: '2026-06-01' },
      { id: 'ac5', name: '持仓Gas返利', type: 'holding_reward', token: 'CX', total: '20,000', claimed: '4,140', claimRate: '20.70%', status: 'active', startDate: '2026-05-15', endDate: '2026-06-15' }
    ]
  },
  shopProducts: {
    A: [
      { id: 'sp1', name: 'Phone X Pro', price: '¥4,999', stock: 300, sold: 234, status: 'on_sale' },
      { id: 'sp2', name: 'Phone Y Lite', price: '¥2,999', stock: 150, sold: 156, status: 'on_sale' }
    ],
    B: [
      { id: 'sp4', name: 'Phone Z Max', price: '¥6,999', stock: 50, sold: 110, status: 'on_sale' }
    ],
    C: [
      { id: 'sp1', name: 'Phone X Pro', price: '¥4,999', stock: 150, sold: 78, status: 'on_sale' },
      { id: 'sp3', name: 'Phone Z Max', price: '¥6,999', stock: 0, sold: 32, status: 'off_sale' }
    ]
  },
  memberPlans: {
    A: [
      { name: '月卡', price: '10.00 TOKEN', period: '30天', subscribers: 2345 },
      { name: '季卡', price: '25.00 TOKEN', period: '90天', subscribers: 1890 },
      { name: '年卡', price: '88.00 TOKEN', period: '365天', subscribers: 999 }
    ],
    B: [
      { name: '月卡', price: '10.00 TOKEN', period: '30天', subscribers: 890 },
      { name: '季卡', price: '25.00 TOKEN', period: '90天', subscribers: 780 },
      { name: '年卡', price: '88.00 TOKEN', period: '365天', subscribers: 430 }
    ],
    C: [
      { name: '月卡', price: '10.00 TOKEN', period: '30天', subscribers: 621 },
      { name: '季卡', price: '25.00 TOKEN', period: '90天', subscribers: 620 },
      { name: '年卡', price: '88.00 TOKEN', period: '365天', subscribers: 357 }
    ]
  },
  recentUsers: {
    A: [
      { id: 'U10001', name: '张三', wallet: '0x1234...5678', member: true, tags: ['会员','硬件购买者'], lastActive: '2026-05-21 14:30' },
      { id: 'U10002', name: '李四', wallet: '0xabcd...efgh', member: false, tags: ['空投领取者'], lastActive: '2026-05-21 13:15' }
    ],
    B: [
      { id: 'U20001', name: '王十二', wallet: '0x2222...3333', member: true, tags: ['会员'], lastActive: '2026-05-21 12:00' }
    ],
    C: [
      { id: 'U30001', name: '赵六', wallet: '0x5555...6666', member: false, tags: ['硬件购买者','空投领取者'], lastActive: '2026-05-21 11:42' },
      { id: 'U30002', name: '孙七', wallet: '0x7777...8888', member: true, tags: ['会员','外部钱包绑定'], lastActive: '2026-05-21 10:20' }
    ]
  },
  reportData: {
    A: { memberTrend: [520,545,570,590,593], airdropTrend: [800,1500,2200,2900,3456], shopTrend: [150,280,420,580,890], revenueTrend: [80000,210000,380000,620000,890000] },
    B: { memberTrend: [200,245,270,290,300], airdropTrend: [0,0,0,0,0], shopTrend: [50,90,130,180,234], revenueTrend: [40000,80000,120000,180000,234500] },
    C: { memberTrend: [100,55,30,10,98], airdropTrend: [400,800,1200,1700,2222], shopTrend: [0,80,130,80,110], revenueTrend: [0,50000,60000,80000,110000] }
  }
};

// ========== 权限工具 ==========

function hasPerm(permKey) {
  return state.currentUser?.perms?.includes(permKey) || false;
}

function getUserProducts() {
  const productIds = state.currentUser?.products || [];
  return state.products.filter(p => productIds.includes(p.id));
}

function getCurrentProduct() {
  if (!state.currentProduct) return null;
  return state.products.find(p => p.id === state.currentProduct);
}

function isGlobalView(viewKey) {
  const globalKeys = GLOBAL_MENUS.flatMap(g => g.items.map(i => i.key));
  return globalKeys.includes(viewKey);
}

function getMenus() {
  const userPerms = state.currentUser?.perms || [];
  return ALL_MENUS.filter(group => userPerms.includes(group.perm));
}

function getDefaultView() {
  const menus = getMenus();
  if (menus.length === 0) return null;
  return menus[0].items[0].key;
}

// ========== 渲染 ==========

function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  switch (state.currentPage) {
    case 'login':
      app.appendChild(renderLogin());
      break;
    case 'dashboard':
      app.appendChild(renderDashboard());
      break;
  }
}

function renderLogin() {
  const div = document.createElement('div');
  div.className = 'login-page';
  div.innerHTML = `
    <div class="login-card">
      <div class="login-logo">
        <h1>IM 开放服务</h1>
        <p>统一后台 · 权限化登录</p>
      </div>
      <div class="login-role-select">
        <div class="login-role-option ${state.selectedRole === 'admin' ? 'selected' : ''}" data-role="admin">
          <div class="role-icon">👑</div>
          <div class="role-name">超级管理员</div>
          <div class="role-desc">开发总部 · 全局管理</div>
        </div>
        <div class="login-role-option ${state.selectedRole === 'operator' ? 'selected' : ''}" data-role="operator">
          <div class="role-icon">💼</div>
          <div class="role-name">产品运营</div>
          <div class="role-desc">运营组织 · 多产品代理</div>
        </div>
      </div>
      <form id="loginForm">
        <div class="form-group">
          <label class="form-label">账号</label>
          <input type="text" class="form-input" placeholder="请输入账号" value="${state.selectedRole === 'admin' ? 'admin' : 'operator_a'}">
        </div>
        <div class="form-group">
          <label class="form-label">密码</label>
          <input type="password" class="form-input" placeholder="请输入密码" value="******">
        </div>
        <button type="submit" class="btn btn-primary btn-lg" style="width: 100%;">登录</button>
      </form>
    </div>
  `;

  div.querySelectorAll('.login-role-option').forEach(el => {
    el.addEventListener('click', () => {
      state.selectedRole = el.dataset.role;
      render();
    });
  });

  div.querySelector('#loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const role = state.selectedRole;
    const roleDef = ROLES[role];
    state.currentUser = {
      name: role === 'admin' ? 'Admin' : '运营A',
      role: role,
      displayName: roleDef.name,
      perms: roleDef.perms,
      products: roleDef.products
    };
    state.currentPage = 'dashboard';
    state.currentView = getDefaultView();
    const userProducts = getUserProducts();
    state.currentProduct = userProducts.length > 0 ? userProducts[0].id : null;
    render();
  });

  return div;
}

function renderDashboard() {
  const div = document.createElement('div');
  div.className = 'layout';
  const menus = getMenus();
  const role = ROLES[state.currentUser.role];
  const userProducts = getUserProducts();
  const currentProduct = getCurrentProduct();
  const showProductBar = !isGlobalView(state.currentView) && userProducts.length > 1;

  const sidebar = document.createElement('aside');
  sidebar.className = 'sidebar';
  sidebar.innerHTML = `
    <div class="sidebar-header">
      <div class="sidebar-brand">IM <span>开放服务</span></div>
      <div class="role-badge ${state.currentUser.role}">
        <span>${role.icon}</span>
        <span>${role.name}</span>
      </div>
    </div>
    <nav class="sidebar-nav">
      ${menus.map(group => `
        <div class="nav-group">
          <div class="nav-group-title">${group.group}</div>
          ${group.items.map(item => `
            <div class="nav-item ${state.currentView === item.key ? 'active' : ''}" data-view="${item.key}">
              <span class="nav-icon">${item.icon}</span>
              <span>${item.label}</span>
            </div>
          `).join('')}
        </div>
      `).join('')}
    </nav>
    <div class="sidebar-footer">
      <div class="user-info">
        <div class="user-avatar">${state.currentUser.name[0]}</div>
        <div>
          <div class="user-name">${state.currentUser.name}</div>
          <div class="user-role">${role.name}</div>
        </div>
      </div>
    </div>
  `;

  const main = document.createElement('main');
  main.className = 'main-content' + (showProductBar ? ' has-product-bar' : '');

  let productBarHtml = '';
  if (showProductBar) {
    productBarHtml = `
      <div class="product-bar">
        <span class="product-bar-label">当前产品</span>
        ${userProducts.map(p => `
          <div class="product-tab ${state.currentProduct === p.id ? 'active' : ''}" data-product="${p.id}">
            <span class="product-dot" style="background: ${p.color};"></span>
            <span>${p.name}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  main.innerHTML = `
    <header class="topbar">
      <h2 class="page-title" id="pageTitle"></h2>
      <div class="topbar-actions">
        ${currentProduct && !isGlobalView(state.currentView) ? `<span class="tag tag-info" style="font-size: 11px;">${currentProduct.icon} ${currentProduct.name}</span>` : ''}
        <button class="btn btn-secondary btn-sm" id="logoutBtn">退出</button>
      </div>
    </header>
    ${productBarHtml}
    <div class="content-area" id="contentArea"></div>
  `;

  div.appendChild(sidebar);
  div.appendChild(main);

  sidebar.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      state.currentView = item.dataset.view;
      render();
    });
  });

  if (showProductBar) {
    main.querySelectorAll('.product-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        state.currentProduct = tab.dataset.product;
        render();
      });
    });
  }

  main.querySelector('#logoutBtn').addEventListener('click', () => {
    state.currentUser = null;
    state.currentPage = 'login';
    state.currentView = null;
    state.currentProduct = null;
    render();
  });

  setTimeout(() => renderMainContent(), 0);
  return div;
}

function renderMainContent() {
  const content = document.getElementById('contentArea');
  const title = document.getElementById('pageTitle');
  if (!content || !title) return;

  const views = {
    services: { title: '服务管理', fn: renderServicesView },
    chains: { title: '链合约管理', fn: renderChainsView },
    products: { title: '产品管理', fn: renderProductsView },
    system: { title: '系统配置', fn: renderSystemConfigView },
    permission: { title: '权限管理', fn: renderPermissionView },
    users: { title: '用户管理', fn: renderUsersView },
    audit: { title: '操作审计', fn: renderAuditView },
    overview: { title: '数据概览', fn: renderOverview },
    member: { title: '会员服务', fn: renderMember },
    airdrop: { title: '激励空投', fn: renderAirdrop },
    shop: { title: '硬件商城', fn: renderShop },
    serviceConfig: { title: '服务配置', fn: renderServiceConfig },
    chainConfig: { title: '链合约配置', fn: renderChainConfig },
    bizConfig: { title: '业务参数', fn: renderBizConfig },
    reports: { title: '运营报表', fn: renderReports }
  };

  const view = views[state.currentView];
  if (view) {
    title.textContent = view.title;
    content.innerHTML = view.fn();
  }
}

// ===== 全局视图（不受产品切换影响）=====

function renderServicesView() {
  const chainModeLabel = { none: '不需要', optional: '可选', required: '必须' };
  const triggerModeLabel = { active: '主动触发', passive: '被动触发', both: '混合模式' };
  return `
    <div style="display: flex; flex-direction: column; gap: 20px;">
      <div class="card">
        <div class="card-header">
          <span class="card-title">服务列表</span>
          <button class="btn btn-primary btn-sm" onclick="showModal('registerService')">+ 注册新服务</button>
        </div>
        <div class="card-body">
          <table class="data-table">
            <thead>
              <tr>
                <th>服务</th><th>Key</th><th>链绑定</th><th>合约类型</th><th>触发模式</th><th>定时任务</th><th>依赖</th><th>已启用产品</th><th style="width:140px;">操作</th>
              </tr>
            </thead>
            <tbody>
              ${state.services.map(s => {
                const usedBy = state.products.filter(p => p.services.includes(s.key));
                const chainNames = s.chains.map(cid => state.chains.find(c => c.id === cid)?.name).filter(Boolean);
                const depNames = s.dependencies.map(dk => state.services.find(sv => sv.key === dk)?.name).filter(Boolean);
                const passiveJobs = (s.cronJobs || []).filter(j => j.type === 'passive');
                const activeJobs = (s.cronJobs || []).filter(j => j.type === 'active');
                return `
                  <tr>
                    <td>
                      <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 20px;">${s.icon}</span>
                        <div><strong>${s.name}</strong><div style="font-size: 11px; color: var(--text-tertiary); margin-top: 1px;">${s.desc}</div></div>
                      </div>
                    </td>
                    <td><code style="background: var(--bg-primary); padding: 2px 8px; border-radius: 4px; font-size: 12px;">${s.key}</code></td>
                    <td>
                      <span class="tag ${s.chainMode === 'required' ? 'tag-warning' : s.chainMode === 'optional' ? 'tag-info' : ''}" style="font-size: 10px;">${chainModeLabel[s.chainMode] || '-'}</span>
                      ${chainNames.length > 0 ? `<div style="font-size: 11px; color: var(--text-tertiary); margin-top: 3px;">${chainNames.join(', ')}</div>` : ''}
                    </td>
                    <td>
                      <div style="display: flex; gap: 4px; flex-wrap: wrap;">
                        ${(s.contractTypes || []).map(ct => `<span class="tag tag-info" style="font-size: 10px;">${ct}</span>`).join('')}
                        ${!s.contractTypes?.length ? '<span style="color: var(--text-tertiary); font-size: 11px;">-</span>' : ''}
                      </div>
                    </td>
                    <td><span class="tag ${s.triggerMode === 'both' ? 'tag-warning' : s.triggerMode === 'passive' ? 'tag-info' : 'tag-success'}" style="font-size: 10px;">${triggerModeLabel[s.triggerMode] || '-'}</span></td>
                    <td>
                      ${passiveJobs.length > 0 ? `<div style="font-size: 11px; color: var(--text-secondary);">⏰ ${passiveJobs.map(j => j.name).join(', ')}</div>` : ''}
                      ${activeJobs.length > 0 ? `<div style="font-size: 11px; color: var(--text-tertiary);">👆 ${activeJobs.map(j => j.name).join(', ')}</div>` : ''}
                      ${!s.cronJobs?.length ? '<span style="color: var(--text-tertiary); font-size: 11px;">-</span>' : ''}
                    </td>
                    <td>${depNames.length > 0 ? depNames.map(n => `<span class="tag" style="font-size: 10px; background: var(--bg-secondary);">${n}</span>`).join(' ') : '<span style="color: var(--text-tertiary); font-size: 11px;">无</span>'}</td>
                    <td>
                      ${usedBy.map(p => `<span class="tag tag-info" style="font-size: 11px;">${p.name}</span>`).join('')}
                      ${usedBy.length === 0 ? '<span style="color: var(--text-tertiary); font-size: 11px;">未启用</span>' : ''}
                    </td>
                    <td>
                      <div style="display: flex; gap: 6px;">
                        <button class="btn btn-secondary btn-sm" onclick="showModal('editService', '${s.key}')">编辑</button>
                        <button class="btn btn-ghost btn-sm" onclick="showModal('serviceDetail', '${s.key}')">详情</button>
                      </div>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function renderChainsView() {
  return `
    <div style="display: flex; flex-direction: column; gap: 20px;">
      <div class="card">
        <div class="card-header">
          <span class="card-title">链列表</span>
          <button class="btn btn-primary btn-sm" onclick="showModal('addChain')">+ 添加链</button>
        </div>
        <div class="card-body">
          <table class="data-table">
            <thead>
              <tr><th>链名称</th><th>链ID</th><th>RPC节点</th><th>Gas币</th><th>关联产品</th><th>合约数</th><th style="width:160px;">操作</th></tr>
            </thead>
            <tbody>
              ${state.chains.map(chain => {
                const contractCount = state.contracts.filter(c => c.chainId === chain.id).length;
                return `
                  <tr>
                    <td><strong>${chain.name}</strong></td>
                    <td><code style="font-size: 12px;">${chain.chainId}</code></td>
                    <td style="font-family: monospace; font-size: 12px;">${chain.rpc}</td>
                    <td><span class="tag tag-warning">${chain.gasToken}</span></td>
                    <td>
                      <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                        ${chain.products.map(pid => {
                          const p = state.products.find(x => x.id === pid);
                          return `<span class="tag tag-info" style="font-size: 11px;">${p?.name}</span>`;
                        }).join('')}
                      </div>
                    </td>
                    <td>${contractCount}</td>
                    <td>
                      <div style="display: flex; gap: 6px;">
                        <button class="btn btn-secondary btn-sm" onclick="showModal('editChain', '${chain.id}')">编辑</button>
                        <button class="btn btn-secondary btn-sm" onclick="alert('查看 ${chain.name} 下的合约列表')">合约</button>
                      </div>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">合约列表</span>
          <button class="btn btn-primary btn-sm" onclick="showModal('addContract')">+ 添加合约</button>
        </div>
        <div class="card-body">
          <table class="data-table">
            <thead>
              <tr><th>合约地址</th><th>类型</th><th>所属链</th><th>所属产品</th><th>代币符号</th><th style="width:120px;">操作</th></tr>
            </thead>
            <tbody>
              ${state.contracts.map(c => {
                const chain = state.chains.find(ch => ch.id === c.chainId);
                const product = state.products.find(p => p.id === c.productId);
                return `
                  <tr>
                    <td style="font-family: monospace; font-size: 12px;">${c.address}</td>
                    <td><span class="tag tag-info">${c.type}</span></td>
                    <td>${chain?.name || c.chainId}</td>
                    <td><span class="tag tag-info" style="font-size: 11px;">${product?.name}</span></td>
                    <td>${c.symbol || '-'}</td>
                    <td><button class="btn btn-secondary btn-sm" onclick="showModal('editContract', '${c.id}')">编辑</button></td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function renderProductsView() {
  return `
    <div style="display: flex; flex-direction: column; gap: 20px;">
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px;">
        ${state.products.map(p => {
          const serviceCount = p.services.length;
          const chainCount = p.chains.length;
          return `
            <div class="product-card" data-product="${p.id}" style="padding: 24px; background: var(--bg-primary); border: 1px solid var(--border); border-radius: var(--radius-md); text-align: center; cursor: pointer;">
              <div style="width: 56px; height: 56px; border-radius: var(--radius-md); background: ${p.color}15; color: ${p.color}; display: flex; align-items: center; justify-content: center; font-size: 28px; margin: 0 auto 12px;">${p.icon}</div>
              <div style="font-size: 16px; font-weight: 600;">${p.name}</div>
              <div style="font-size: 13px; color: var(--text-tertiary); margin-top: 4px;">${p.desc}</div>
              <div style="display: flex; gap: 8px; justify-content: center; margin-top: 16px;">
                <span class="tag tag-info" style="font-size: 11px;">${serviceCount} 个服务</span>
                <span class="tag tag-warning" style="font-size: 11px;">${chainCount} 条链</span>
              </div>
              <div style="margin-top: 16px; display: flex; gap: 8px;">
                <button class="btn btn-primary btn-sm enter-product-btn" data-product="${p.id}" style="flex: 1;">进入运营</button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">产品概览</span></div>
        <div class="card-body">
          <table class="data-table">
            <thead>
              <tr><th>产品</th><th>已启用服务</th><th>已配置链</th><th>合约数</th><th>操作</th></tr>
            </thead>
            <tbody>
              ${state.products.map(p => {
                const contractCount = state.contracts.filter(c => c.productId === p.id).length;
                return `
                  <tr>
                    <td>
                      <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 20px;">${p.icon}</span>
                        <strong>${p.name}</strong>
                      </div>
                    </td>
                    <td>
                      <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                        ${p.services.map(sk => {
                          const s = state.services.find(x => x.key === sk);
                          return `<span class="tag tag-info" style="font-size: 11px;">${s?.icon} ${s?.name}</span>`;
                        }).join('')}
                      </div>
                    </td>
                    <td>
                      <div style="display: flex; gap: 6px;">
                        ${p.chains.map(cid => {
                          const ch = state.chains.find(x => x.id === cid);
                          return `<span class="tag tag-warning" style="font-size: 11px;">${ch?.name}</span>`;
                        }).join('')}
                      </div>
                    </td>
                    <td>${contractCount}</td>
                    <td>
                      <div style="display: flex; gap: 6px;">
                        <button class="btn btn-primary btn-sm enter-product-btn" data-product="${p.id}">进入运营</button>
                        <button class="btn btn-secondary btn-sm" onclick="showModal('productDetail', '${p.id}')">详情</button>
                      </div>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function renderSystemConfigView() {
  return `
    <div style="display: flex; flex-direction: column; gap: 20px;">
      <div class="card">
        <div class="card-header"><span class="card-title">服务实例</span></div>
        <div class="card-body">
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px;">
            ${state.instances.map(inst => {
              const product = state.products.find(p => p.id === inst.productId);
              return `
                <div style="padding: 20px; border: 1px solid var(--border); border-radius: var(--radius-md);">
                  <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
                    <div style="display: flex; align-items: center; gap: 10px;">
                      <span style="font-size: 20px;">${product?.icon || '🖥️'}</span>
                      <div><div style="font-weight: 600;">${inst.name}</div><div style="font-size: 12px; color: var(--text-tertiary);">${inst.host}</div></div>
                    </div>
                    <span class="tag tag-success">运行中</span>
                  </div>
                  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 13px;">
                    <div><span style="color: var(--text-tertiary);">版本</span><div style="font-weight: 500; margin-top: 2px;">${inst.version}</div></div>
                    <div><span style="color: var(--text-tertiary);">运行时间</span><div style="font-weight: 500; margin-top: 2px;">${inst.uptime}</div></div>
                    <div><span style="color: var(--text-tertiary);">CPU</span><div style="font-weight: 500; margin-top: 2px;">${inst.cpu}</div></div>
                    <div><span style="color: var(--text-tertiary);">内存</span><div style="font-weight: 500; margin-top: 2px;">${inst.memory}</div></div>
                  </div>
                  <div style="margin-top: 16px; display: flex; gap: 8px;">
                    <button class="btn btn-secondary btn-sm" onclick="showModal('editInstance', '${inst.id}')">配置</button>
                    <button class="btn btn-secondary btn-sm" onclick="alert('重启 ${inst.name}')">重启</button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">API 网关路由</span>
          <button class="btn btn-primary btn-sm" onclick="showModal('editGateway')">编辑路由</button>
        </div>
        <div class="card-body">
          <table class="data-table">
            <thead>
              <tr><th>产品</th><th>域名</th><th>上游地址</th><th>SSL</th><th>限流</th><th>操作</th></tr>
            </thead>
            <tbody>
              ${state.gatewayRoutes.map(r => {
                const product = state.products.find(p => p.id === r.productId);
                return `
                  <tr>
                    <td><span class="tag tag-info" style="font-size: 11px;">${product?.name}</span></td>
                    <td style="font-family: monospace; font-size: 12px;">${r.domain}</td>
                    <td style="font-family: monospace; font-size: 12px;">${r.upstream}</td>
                    <td>${r.ssl ? '<span class="tag tag-success">已启用</span>' : '<span class="tag">未启用</span>'}</td>
                    <td>${r.rateLimit}</td>
                    <td><button class="btn btn-secondary btn-sm" onclick="showModal('editGatewayRoute', '${r.productId}')">编辑</button></td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
        <div class="card">
          <div class="card-header">
            <span class="card-title">数据库连接</span>
            <button class="btn btn-primary btn-sm" onclick="showModal('editDatabase')">编辑配置</button>
          </div>
          <div class="card-body">
            <table class="data-table">
              <thead><tr><th>名称</th><th>类型</th><th>地址</th><th>连接池</th><th>状态</th></tr></thead>
              <tbody>
                ${state.databases.map(db => `
                  <tr>
                    <td><strong>${db.name}</strong></td>
                    <td><span class="tag tag-info" style="font-size: 11px;">${db.type}</span></td>
                    <td style="font-family: monospace; font-size: 12px;">${db.host}</td>
                    <td>${db.connPool}</td>
                    <td><span class="tag tag-success">已连接</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <div class="card-header">
            <span class="card-title">缓存配置</span>
            <button class="btn btn-primary btn-sm" onclick="showModal('editCache')">编辑配置</button>
          </div>
          <div class="card-body">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px;">
              <div style="padding: 16px; background: var(--bg-secondary); border-radius: var(--radius-md);">
                <div style="font-size: 12px; color: var(--text-tertiary); margin-bottom: 4px;">Redis 地址</div>
                <div style="font-family: monospace; font-size: 13px;">${state.cacheConfig.host}</div>
              </div>
              <div style="padding: 16px; background: var(--bg-secondary); border-radius: var(--radius-md);">
                <div style="font-size: 12px; color: var(--text-tertiary); margin-bottom: 4px;">最大内存</div>
                <div style="font-size: 13px; font-weight: 500;">${state.cacheConfig.maxMemory}</div>
              </div>
            </div>
            <table class="data-table">
              <thead><tr><th>缓存项</th><th>TTL</th><th>更新策略</th></tr></thead>
              <tbody>
                ${state.cacheConfig.policies.map(p => `
                  <tr><td>${p.key}</td><td><span class="tag ${p.ttl === '不缓存' ? '' : 'tag-warning'}" style="font-size: 11px;">${p.ttl}</span></td><td style="font-size: 12px;">${p.updateStrategy}</td></tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
        <div class="card">
          <div class="card-header">
            <span class="card-title">认证与安全</span>
            <button class="btn btn-primary btn-sm" onclick="showModal('editAuth')">编辑配置</button>
          </div>
          <div class="card-body">
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 20px;">
              <div style="padding: 16px; background: var(--bg-secondary); border-radius: var(--radius-md);">
                <div style="font-size: 12px; color: var(--text-tertiary); margin-bottom: 4px;">Token 过期时间</div>
                <div style="font-size: 15px; font-weight: 600;">${state.authConfig.jwtExpire}</div>
              </div>
              <div style="padding: 16px; background: var(--bg-secondary); border-radius: var(--radius-md);">
                <div style="font-size: 12px; color: var(--text-tertiary); margin-bottom: 4px;">登录失败锁定</div>
                <div style="font-size: 15px; font-weight: 600;">${state.authConfig.loginFailLock}次</div>
              </div>
              <div style="padding: 16px; background: var(--bg-secondary); border-radius: var(--radius-md);">
                <div style="font-size: 12px; color: var(--text-tertiary); margin-bottom: 4px;">二次验证</div>
                <div style="font-size: 15px; font-weight: 600;">${state.authConfig.twoFactor ? '已启用' : '未启用'}</div>
              </div>
            </div>
            <div>
              <div style="font-size: 13px; color: var(--text-secondary); margin-bottom: 8px;">IP 白名单</div>
              <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                ${state.authConfig.ipWhitelist.map(ip => `<span class="tag" style="background: var(--bg-secondary); font-family: monospace; font-size: 12px;">${ip}</span>`).join('')}
              </div>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">定时任务</span></div>
          <div class="card-body">
            <table class="data-table">
              <thead><tr><th>任务名称</th><th>执行周期</th><th>关联产品</th><th>状态</th><th>上次执行</th><th>操作</th></tr></thead>
              <tbody>
                ${state.cronJobs.map(job => {
                  const product = job.productId ? state.products.find(p => p.id === job.productId) : null;
                  return `
                    <tr>
                      <td><strong>${job.name}</strong></td>
                      <td style="font-size: 12px;">${job.schedule}</td>
                      <td>${product ? `<span class="tag tag-info" style="font-size: 11px;">${product.name}</span>` : '<span style="color: var(--text-tertiary); font-size: 12px;">全局</span>'}</td>
                      <td>${job.status === 'active' ? '<span class="tag tag-success">运行中</span>' : '<span class="tag tag-warning">已暂停</span>'}</td>
                      <td style="font-size: 12px; color: var(--text-secondary);">${job.lastRun}</td>
                      <td>
                        <div style="display: flex; gap: 6px;">
                          <button class="btn btn-secondary btn-sm" onclick="showModal('editCronJob', '${job.id}')">编辑</button>
                          <button class="btn btn-secondary btn-sm" onclick="alert('${job.status === 'active' ? '暂停' : '恢复'} ${job.name}')">${job.status === 'active' ? '暂停' : '恢复'}</button>
                        </div>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderPermissionView() {
  const accounts = state.adminAccounts || [];
  const roleOptions = [
    { key: 'admin', name: '超级管理员', desc: '开发总部 · 全局管理' },
    { key: 'operator', name: '产品运营', desc: '运营组织 · 多产品代理' }
  ];
  return `
    <div style="display: flex; flex-direction: column; gap: 20px;">
      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px;">
        <div class="stat-card"><div class="stat-card-label">总账号数</div><div class="stat-card-value">${accounts.length}</div></div>
        <div class="stat-card"><div class="stat-card-label">超级管理员</div><div class="stat-card-value">${accounts.filter(a => a.role === 'admin').length}</div></div>
        <div class="stat-card"><div class="stat-card-label">产品运营</div><div class="stat-card-value">${accounts.filter(a => a.role === 'operator').length}</div></div>
        <div class="stat-card"><div class="stat-card-label">已停用</div><div class="stat-card-value">${accounts.filter(a => a.status === 'disabled').length}</div></div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">账号列表</span>
          <button class="btn btn-primary btn-sm" onclick="showModal('createAccount')">+ 创建账号</button>
        </div>
        <div class="card-body">
          <table class="data-table">
            <thead>
              <tr><th>账号</th><th>显示名称</th><th>角色</th><th>产品权限</th><th>状态</th><th>最后登录</th><th>创建时间</th><th style="width:180px;">操作</th></tr>
            </thead>
            <tbody>
              ${accounts.map(acc => `
                <tr>
                  <td><strong>${acc.username}</strong></td>
                  <td>${acc.displayName}</td>
                  <td><span class="tag ${acc.role === 'admin' ? 'tag-warning' : 'tag-info'}" style="font-size: 11px;">${acc.roleName}</span></td>
                  <td>
                    <div style="display: flex; gap: 4px; flex-wrap: wrap;">
                      ${acc.productNames.map(pn => `<span class="tag tag-info" style="font-size: 10px;">${pn}</span>`).join('')}
                    </div>
                  </td>
                  <td>${acc.status === 'active' ? '<span class="tag tag-success">正常</span>' : '<span class="tag tag-danger">已停用</span>'}</td>
                  <td style="font-size: 12px; color: var(--text-secondary);">${acc.lastLogin}</td>
                  <td style="font-size: 12px; color: var(--text-tertiary);">${acc.createdAt}</td>
                  <td>
                    <div style="display: flex; gap: 6px;">
                      <button class="btn btn-secondary btn-sm" onclick="showModal('editAccount', '${acc.id}')">编辑</button>
                      <button class="btn btn-secondary btn-sm" onclick="showModal('resetPassword', '${acc.id}')">重置密码</button>
                      <button class="btn btn-ghost btn-sm" onclick="showModal('${acc.status === 'active' ? 'disable' : 'enable'}Account', '${acc.id}')">${acc.status === 'active' ? '停用' : '启用'}</button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">角色权限说明</span></div>
        <div class="card-body">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
            ${roleOptions.map(r => `
              <div style="padding: 20px; border: 1px solid var(--border); border-radius: var(--radius-md);">
                <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px;">
                  <span style="font-size: 20px;">${r.key === 'admin' ? '👑' : '💼'}</span>
                  <div>
                    <div style="font-weight: 600;">${r.name}</div>
                    <div style="font-size: 12px; color: var(--text-tertiary);">${r.desc}</div>
                  </div>
                </div>
                <div style="font-size: 13px; color: var(--text-secondary); line-height: 1.8;">
                  ${r.key === 'admin' ? `
                    <div>✓ 服务管理（注册、编辑、查看）</div>
                    <div>✓ 链合约管理（添加、配置）</div>
                    <div>✓ 产品管理（创建、配置）</div>
                    <div>✓ 系统配置（实例、网关、数据库）</div>
                    <div>✓ 权限管理（创建下级账号）</div>
                    <div>✓ 审计日志查看</div>
                    <div>✓ 所有产品的运营数据与配置</div>
                  ` : `
                    <div>✓ 数据概览、运营报表</div>
                    <div>✓ 会员服务、激励空投、硬件商城管理</div>
                    <div>✓ 用户管理</div>
                    <div>✓ 产品内服务配置、链合约配置、业务参数</div>
                    <div>✗ 全局服务/链/产品管理</div>
                    <div>✗ 系统配置</div>
                    <div>✗ 权限管理</div>
                  `}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderAuditView() {
  return `
    <div class="card">
      <div class="card-header">
        <span class="card-title">操作审计日志</span>
        <div style="display: flex; gap: 10px;">
          <select class="form-input" style="width: 140px;">
            <option>所有模块</option><option>服务管理</option><option>链合约管理</option><option>产品管理</option>
          </select>
          <select class="form-input" style="width: 140px;">
            <option>所有产品</option><option>产品A</option><option>产品B</option><option>产品C</option>
          </select>
          <input type="text" class="form-input" placeholder="搜索操作人" style="width: 160px;">
          <button class="btn btn-secondary" onclick="alert('筛选审计日志')">筛选</button>
        </div>
      </div>
      <div class="card-body">
        <table class="data-table">
          <thead><tr><th>时间</th><th>操作人</th><th>操作</th><th>模块</th><th>产品</th><th>详情</th></tr></thead>
          <tbody>
            ${state.auditLogs.map(log => `
              <tr>
                <td>${log.time}</td>
                <td>${log.user}</td>
                <td><span class="tag tag-info">${log.action}</span></td>
                <td>${log.module}</td>
                <td>${log.product ? `<span class="tag tag-info" style="font-size: 11px;">${log.product}</span>` : '-'}</td>
                <td><a href="#" style="color: var(--brand-primary); text-decoration: none;" onclick="showModal('auditDetail', '${log.time}'); return false;">${log.detail}</a></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ===== 产品内视图（随产品切换展示不同数据）=====

function getProductData(key, defaultValue) {
  const pid = state.currentProduct;
  if (!pid) return defaultValue;
  return state[key]?.[pid] ?? defaultValue;
}

function makeChartBars(data, maxBars) {
  const sliced = data.slice(-maxBars);
  const max = Math.max(...sliced);
  return sliced.map(v => `<div class="chart-bar" style="height: ${Math.max((v / max) * 100, 5)}%;" title="${v}"></div>`).join('');
}

function renderOverview() {
  const s = getProductData('stats', {});
  const pid = state.currentProduct;
  const p = getCurrentProduct();
  return `
    <div style="display: flex; flex-direction: column; gap: 20px;">
      <div class="card" style="background: linear-gradient(135deg, ${p?.color}10 0%, ${p?.color}05 100%); border-color: ${p?.color}30;">
        <div class="card-body" style="display: flex; align-items: center; gap: 16px;">
          <span style="font-size: 36px;">${p?.icon}</span>
          <div>
            <div style="font-size: 18px; font-weight: 700;">${p?.name}</div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-top: 2px;">${p?.desc} · 已启用 ${p?.services?.length} 个服务 · ${p?.chains?.length} 条链</div>
          </div>
        </div>
      </div>
      <div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 16px;">
        <div class="stat-card">
          <div class="stat-card-label">总用户数</div>
          <div class="stat-card-value">${(s.totalUsers || 0).toLocaleString()}</div>
          <div class="stat-card-change up">↑ 3.2% 较上周</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-label">活跃用户</div>
          <div class="stat-card-value">${(s.activeUsers || 0).toLocaleString()}</div>
          <div class="stat-card-change up">↑ 5.1% 较上周</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-label">会员数</div>
          <div class="stat-card-value">${(s.memberCount || 0).toLocaleString()}</div>
          <div class="stat-card-change up">↑ 2.8% 较上周</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-label">空投已领取</div>
          <div class="stat-card-value">${(s.airdropClaimed || 0).toLocaleString()}</div>
          <div class="stat-card-change up">↑ 12.3% 较上周</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-label">商城营收</div>
          <div class="stat-card-value">${s.shopRevenue || '¥0'}</div>
          <div class="stat-card-change up">↑ 8.7% 较上周</div>
        </div>
      </div>
      <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 20px;">
        <div class="card">
          <div class="card-header">
            <span class="card-title">用户活跃趋势（近30天）</span>
            <div style="display: flex; gap: 8px;">
              <button class="btn btn-ghost btn-sm">日</button>
              <button class="btn btn-secondary btn-sm">周</button>
              <button class="btn btn-secondary btn-sm">月</button>
            </div>
          </div>
          <div class="card-body">
            <div class="chart-placeholder">${makeChartBars(getProductData('dailyData', []), 30)}</div>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">服务数据</span></div>
          <div class="card-body">
            <div style="display: flex; flex-direction: column; gap: 20px;">
              <div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                  <span style="font-size: 13px;">会员转化率</span><span style="font-size: 13px; font-weight: 600;">${s.memberRate || '0%'}</span>
                </div>
                <div class="progress-bar"><div class="progress-bar-fill" style="width: ${parseFloat(s.memberRate || 0)}%;"></div></div>
              </div>
              <div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                  <span style="font-size: 13px;">空投领取率</span><span style="font-size: 13px; font-weight: 600;">${s.airdropTotal ? (s.airdropClaimed / s.airdropTotal * 100).toFixed(1) : '0.0'}%</span>
                </div>
                <div class="progress-bar"><div class="progress-bar-fill" style="width: ${s.airdropTotal ? (s.airdropClaimed / s.airdropTotal * 100).toFixed(1) : 0}%;"></div></div>
              </div>
              <div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                  <span style="font-size: 13px;">钱包绑定率</span><span style="font-size: 13px; font-weight: 600;">${s.totalUsers ? (s.walletBound / s.totalUsers * 100).toFixed(1) : '0.0'}%</span>
                </div>
                <div class="progress-bar"><div class="progress-bar-fill" style="width: ${s.totalUsers ? (s.walletBound / s.totalUsers * 100).toFixed(1) : 0}%;"></div></div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">近期活跃用户</span>
          <button class="btn btn-ghost btn-sm" onclick="state.currentView='users';render();">查看全部 →</button>
        </div>
        <div class="card-body">
          <table class="data-table">
            <thead><tr><th>用户ID</th><th>名称</th><th>钱包</th><th>会员</th><th>标签</th><th>最后活跃</th></tr></thead>
            <tbody>
              ${getProductData('recentUsers', []).map(u => `
                <tr>
                  <td style="font-family: monospace; font-size: 12px;">${u.id}</td>
                  <td><strong>${u.name}</strong></td>
                  <td style="font-family: monospace; font-size: 12px;">${u.wallet}</td>
                  <td>${u.member ? '<span class="tag tag-success">会员</span>' : '<span class="tag">非会员</span>'}</td>
                  <td><div style="display: flex; gap: 4px; flex-wrap: wrap;">${u.tags.map(t => `<span class="tag tag-info" style="font-size: 10px;">${t}</span>`).join('')}</div></td>
                  <td style="font-size: 12px; color: var(--text-tertiary);">${u.lastActive}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function renderMember() {
  const s = getProductData('stats', {});
  const plans = getProductData('memberPlans', []);
  const pid = state.currentProduct;
  return `
    <div style="display: flex; flex-direction: column; gap: 20px;">
      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px;">
        <div class="stat-card"><div class="stat-card-label">会员总数</div><div class="stat-card-value">${(s.memberCount || 0).toLocaleString()}</div></div>
        <div class="stat-card"><div class="stat-card-label">会员转化率</div><div class="stat-card-value">${s.memberRate || '0%'}</div></div>
        <div class="stat-card"><div class="stat-card-label">本月新增</div><div class="stat-card-value">342</div><div class="stat-card-change up">↑ 15.2%</div></div>
        <div class="stat-card"><div class="stat-card-label">续费率</div><div class="stat-card-value">78.5%</div></div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">会员套餐</span>
          <button class="btn btn-primary btn-sm" onclick="showModal('editMemberPlan')">编辑套餐</button>
        </div>
        <div class="card-body">
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px;">
            ${plans.map(p => `
              <div style="padding: 20px; border: 1px solid var(--border); border-radius: var(--radius-md); text-align: center;">
                <div style="font-size: 16px; font-weight: 600; margin-bottom: 8px;">${p.name}</div>
                <div style="font-size: 24px; font-weight: 700; color: var(--brand-primary); margin-bottom: 4px;">${p.price}</div>
                <div style="font-size: 12px; color: var(--text-tertiary); margin-bottom: 16px;">${p.period}</div>
                <div style="font-size: 13px; color: var(--text-secondary);">订阅人数 <strong>${p.subscribers.toLocaleString()}</strong></div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">会员增长趋势</span></div>
        <div class="card-body"><div class="chart-placeholder">${makeChartBars(getProductData('reportData', {}).memberTrend || [], 5)}</div></div>
      </div>
    </div>
  `;
}

function renderAirdrop() {
  const s = getProductData('stats', {});
  const campaigns = getProductData('airdropCampaigns', []);
  const pid = state.currentProduct;
  return `
    <div style="display: flex; flex-direction: column; gap: 20px;">
      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px;">
        <div class="stat-card"><div class="stat-card-label">活动总数</div><div class="stat-card-value">${campaigns.length}</div></div>
        <div class="stat-card"><div class="stat-card-label">进行中</div><div class="stat-card-value">${campaigns.filter(c => c.status === 'active').length}</div></div>
        <div class="stat-card"><div class="stat-card-label">已领取人次</div><div class="stat-card-value">${(s.airdropClaimed || 0).toLocaleString()}</div></div>
        <div class="stat-card"><div class="stat-card-label">平均领取率</div><div class="stat-card-value">${s.airdropTotal ? (s.airdropClaimed / s.airdropTotal * 100).toFixed(2) : '0.00'}%</div></div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">空投活动列表</span>
          <button class="btn btn-primary btn-sm" onclick="showModal('createAirdrop')">+ 创建活动</button>
        </div>
        <div class="card-body">
          ${campaigns.length === 0 ? '<div style="text-align: center; padding: 40px; color: var(--text-tertiary);">该产品暂无空投活动</div>' : `
          <table class="data-table">
            <thead><tr><th>活动名称</th><th>类型</th><th>奖励代币</th><th>总额度</th><th>已领取</th><th>领取率</th><th>状态</th><th>时间</th><th>操作</th></tr></thead>
            <tbody>
              ${campaigns.map(c => `
                <tr>
                  <td><strong>${c.name}</strong></td>
                  <td><span class="tag tag-info" style="font-size: 11px;">${c.type === 'token_drop' ? '普通空投' : '持仓返利'}</span></td>
                  <td>${c.token}</td>
                  <td>${c.total}</td>
                  <td>${c.claimed}</td>
                  <td><strong>${c.claimRate}</strong></td>
                  <td>${c.status === 'active' ? '<span class="tag tag-success">进行中</span>' : '<span class="tag">已结束</span>'}</td>
                  <td style="font-size: 12px; color: var(--text-tertiary);">${c.startDate} ~ ${c.endDate}</td>
                  <td>
                    <div style="display: flex; gap: 6px;">
                      <button class="btn btn-secondary btn-sm" onclick="showModal('editAirdrop', '${c.id}')">编辑</button>
                      <button class="btn btn-ghost btn-sm" onclick="showModal('airdropDetail', '${c.id}')">详情</button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          `}
        </div>
      </div>
    </div>
  `;
}

function renderShop() {
  const s = getProductData('stats', {});
  const products = getProductData('shopProducts', []);
  const pid = state.currentProduct;
  return `
    <div style="display: flex; flex-direction: column; gap: 20px;">
      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px;">
        <div class="stat-card"><div class="stat-card-label">总订单数</div><div class="stat-card-value">${(s.shopOrders || 0).toLocaleString()}</div></div>
        <div class="stat-card"><div class="stat-card-label">总营收</div><div class="stat-card-value">${s.shopRevenue || '¥0'}</div></div>
        <div class="stat-card"><div class="stat-card-label">在售商品</div><div class="stat-card-value">${products.filter(p => p.status === 'on_sale').length}</div></div>
        <div class="stat-card"><div class="stat-card-label">购买者标记</div><div class="stat-card-value">${products.reduce((a, p) => a + p.sold, 0).toLocaleString()}</div></div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">商品列表</span>
          <button class="btn btn-primary btn-sm" onclick="showModal('addProduct')">+ 添加商品</button>
        </div>
        <div class="card-body">
          <table class="data-table">
            <thead><tr><th>商品名称</th><th>价格</th><th>库存</th><th>已售</th><th>销量进度</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              ${products.map(p => {
                const total = p.stock + p.sold;
                const rate = total > 0 ? (p.sold / total * 100).toFixed(0) : 0;
                return `
                  <tr>
                    <td><strong>${p.name}</strong></td>
                    <td style="font-weight: 600;">${p.price}</td>
                    <td>${p.stock}</td>
                    <td>${p.sold}</td>
                    <td style="width: 140px;">
                      <div class="progress-bar"><div class="progress-bar-fill" style="width: ${rate}%;"></div></div>
                      <div style="font-size: 11px; color: var(--text-tertiary); margin-top: 4px;">${rate}%</div>
                    </td>
                    <td>${p.status === 'on_sale' ? '<span class="tag tag-success">在售</span>' : '<span class="tag">下架</span>'}</td>
                    <td>
                      <div style="display: flex; gap: 6px;">
                        <button class="btn btn-secondary btn-sm" onclick="showModal('editProduct', '${p.id}')">编辑</button>
                        <button class="btn btn-ghost btn-sm">${p.status === 'on_sale' ? '下架' : '上架'}</button>
                      </div>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function renderUsersView() {
  const pid = state.currentProduct;
  const users = getProductData('recentUsers', []);
  return `
    <div class="card">
      <div class="card-header"><span class="card-title">用户管理</span></div>
      <div class="card-body">
        <div style="display: flex; gap: 12px; margin-bottom: 24px;">
          <input type="text" class="form-input" placeholder="输入用户ID或钱包地址" style="flex: 1;">
          <button class="btn btn-primary" onclick="alert('查询用户')">查询</button>
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 24px;">
          <span class="tag tag-info">会员用户</span>
          <span class="tag tag-success">硬件购买者</span>
          <span class="tag tag-warning">空投领取者</span>
          <span class="tag tag-info">外部钱包绑定</span>
          <span class="tag tag-success">高活跃用户</span>
        </div>
        <table class="data-table">
          <thead><tr><th>用户ID</th><th>名称</th><th>钱包</th><th>会员</th><th>标签</th><th>最后活跃</th></tr></thead>
          <tbody>
            ${users.map(u => `
              <tr>
                <td style="font-family: monospace; font-size: 12px;">${u.id}</td>
                <td><strong>${u.name}</strong></td>
                <td style="font-family: monospace; font-size: 12px;">${u.wallet}</td>
                <td>${u.member ? '<span class="tag tag-success">会员</span>' : '<span class="tag">非会员</span>'}</td>
                <td><div style="display: flex; gap: 4px; flex-wrap: wrap;">${u.tags.map(t => `<span class="tag tag-info" style="font-size: 10px;">${t}</span>`).join('')}</div></td>
                <td style="font-size: 12px; color: var(--text-tertiary);">${u.lastActive}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderServiceConfig() {
  const pid = state.currentProduct;
  const p = getCurrentProduct();
  const enabledServices = state.services.filter(s => p?.services?.includes(s.key));
  return `
    <div style="display: flex; flex-direction: column; gap: 20px;">
      <div class="card">
        <div class="card-header">
          <span class="card-title">${p?.name} - 已启用服务</span>
        </div>
        <div class="card-body">
          <div style="display: flex; flex-direction: column; gap: 12px;">
            ${enabledServices.map(s => `
              <div style="display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border: 1px solid var(--border); border-radius: var(--radius-sm);">
                <div style="display: flex; align-items: center; gap: 12px;">
                  <span style="font-size: 22px;">${s.icon}</span>
                  <div><div style="font-weight: 600; font-size: 14px;">${s.name}</div><div style="font-size: 12px; color: var(--text-tertiary);">${s.desc}</div></div>
                </div>
                <div style="display: flex; align-items: center; gap: 12px;">
                  <label class="switch">
                    <input type="checkbox" ${s.status === 'active' ? 'checked' : ''} data-service="${s.key}">
                    <span class="switch-slider"></span>
                  </label>
                  ${s.status === 'active' ? `<button class="btn btn-secondary btn-sm" onclick="showModal('configService', '${s.key}')">配置</button>` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderChainConfig() {
  const pid = state.currentProduct;
  const p = getCurrentProduct();
  const productChains = state.chains.filter(ch => ch.products.includes(pid));
  const productContracts = state.contracts.filter(c => c.productId === pid);
  return `
    <div style="display: flex; flex-direction: column; gap: 20px;">
      <div class="card">
        <div class="card-header"><span class="card-title">${p?.name} - 已配置链</span></div>
        <div class="card-body">
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px;">
            ${productChains.map(ch => `
              <div style="padding: 20px; border: 1px solid var(--border); border-radius: var(--radius-md);">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;">
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="width: 8px; height: 8px; border-radius: 50%; background: var(--color-success);"></span>
                    <strong>${ch.name}</strong>
                    <span class="tag tag-success" style="font-size: 10px;">运行中</span>
                  </div>
                  <button class="btn btn-secondary btn-sm" onclick="showModal('editChain', '${ch.id}')">编辑</button>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 13px;">
                  <div><span style="color: var(--text-tertiary);">链ID</span><div style="font-family: monospace; margin-top: 2px;">${ch.chainId}</div></div>
                  <div><span style="color: var(--text-tertiary);">Gas币</span><div style="margin-top: 2px;">${ch.gasToken}</div></div>
                </div>
              </div>
            `).join('')}
            ${productChains.length === 0 ? '<div style="text-align: center; padding: 40px; color: var(--text-tertiary);">该产品暂未配置链</div>' : ''}
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">合约配置</span>
          <button class="btn btn-primary btn-sm" onclick="showModal('addContract')">+ 添加合约</button>
        </div>
        <div class="card-body">
          <table class="data-table">
            <thead><tr><th>合约地址</th><th>类型</th><th>所属链</th><th>代币符号</th><th>操作</th></tr></thead>
            <tbody>
              ${productContracts.map(c => {
                const chain = state.chains.find(ch => ch.id === c.chainId);
                return `
                  <tr>
                    <td style="font-family: monospace; font-size: 12px;">${c.address}</td>
                    <td><span class="tag tag-info" style="font-size: 11px;">${c.type}</span></td>
                    <td>${chain?.name}</td>
                    <td>${c.symbol || '-'}</td>
                    <td><button class="btn btn-secondary btn-sm" onclick="showModal('editContract', '${c.id}')">编辑</button></td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function renderBizConfig() {
  const p = getCurrentProduct();
  return `
    <div style="display: flex; flex-direction: column; gap: 20px;">
      <div class="card">
        <div class="card-header"><span class="card-title">${p?.name} - 会员服务参数</span></div>
        <div class="card-body">
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px;">
            <div class="form-group"><label class="form-label">月卡价格</label><input type="text" class="form-input" value="10.00"></div>
            <div class="form-group"><label class="form-label">季卡价格</label><input type="text" class="form-input" value="25.00"></div>
            <div class="form-group"><label class="form-label">年卡价格</label><input type="text" class="form-input" value="88.00"></div>
          </div>
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 4px;">
            <div class="form-group"><label class="form-label">自动续费</label><label class="switch" style="margin-top: 4px;"><input type="checkbox" checked><span class="switch-slider"></span></label></div>
            <div class="form-group"><label class="form-label">支持外部钱包支付</label><label class="switch" style="margin-top: 4px;"><input type="checkbox"><span class="switch-slider"></span></label></div>
          </div>
          <div style="margin-top: 12px;"><button class="btn btn-primary btn-sm" onclick="alert('保存成功')">保存参数</button></div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">${p?.name} - 空投服务参数</span></div>
        <div class="card-body">
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px;">
            <div class="form-group"><label class="form-label">默认领取模式</label><select class="form-input"><option>后台代发</option><option>合约Claim</option></select></div>
            <div class="form-group"><label class="form-label">持仓快照周期</label><select class="form-input"><option>每天</option><option>每周</option><option>每月</option></select></div>
          </div>
          <div style="margin-top: 12px;"><button class="btn btn-primary btn-sm" onclick="alert('保存成功')">保存参数</button></div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">${p?.name} - 商城服务参数</span></div>
        <div class="card-body">
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px;">
            <div class="form-group"><label class="form-label">默认支付方式</label><select class="form-input"><option>平台余额</option><option>链上支付</option></select></div>
            <div class="form-group"><label class="form-label">每人限购数量</label><input type="number" class="form-input" value="2"></div>
          </div>
          <div style="margin-top: 12px;"><button class="btn btn-primary btn-sm" onclick="alert('保存成功')">保存参数</button></div>
        </div>
      </div>
    </div>
  `;
}

function renderReports() {
  const pid = state.currentProduct;
  const p = getCurrentProduct();
  const rd = getProductData('reportData', {});
  return `
    <div style="display: flex; flex-direction: column; gap: 20px;">
      <div style="display: flex; gap: 12px; align-items: center;">
        <select class="form-input" style="width: 140px;"><option>最近7天</option><option>最近30天</option><option>最近90天</option></select>
        <select class="form-input" style="width: 140px;"><option>所有服务</option><option>会员服务</option><option>激励空投</option><option>硬件商城</option></select>
        <button class="btn btn-primary btn-sm">导出报表</button>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
        <div class="card">
          <div class="card-header"><span class="card-title">会员增长趋势</span></div>
          <div class="card-body"><div class="chart-placeholder">${makeChartBars(rd.memberTrend || [], 5)}</div><div style="display: flex; justify-content: space-between; margin-top: 12px; font-size: 12px; color: var(--text-tertiary);"><span>1月</span><span>2月</span><span>3月</span><span>4月</span><span>5月</span></div></div>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">空投领取趋势</span></div>
          <div class="card-body"><div class="chart-placeholder">${makeChartBars(rd.airdropTrend || [], 5)}</div><div style="display: flex; justify-content: space-between; margin-top: 12px; font-size: 12px; color: var(--text-tertiary);"><span>1月</span><span>2月</span><span>3月</span><span>4月</span><span>5月</span></div></div>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">商城订单趋势</span></div>
          <div class="card-body"><div class="chart-placeholder">${makeChartBars(rd.shopTrend || [], 5)}</div><div style="display: flex; justify-content: space-between; margin-top: 12px; font-size: 12px; color: var(--text-tertiary);"><span>1月</span><span>2月</span><span>3月</span><span>4月</span><span>5月</span></div></div>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">营收趋势</span></div>
          <div class="card-body"><div class="chart-placeholder">${makeChartBars(rd.revenueTrend || [], 5)}</div><div style="display: flex; justify-content: space-between; margin-top: 12px; font-size: 12px; color: var(--text-tertiary);"><span>1月</span><span>2月</span><span>3月</span><span>4月</span><span>5月</span></div></div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">${p?.name} - 服务数据汇总</span></div>
        <div class="card-body">
          <table class="data-table">
            <thead><tr><th>服务</th><th>用户数</th><th>转化率</th><th>较上月</th><th>营收贡献</th></tr></thead>
            <tbody>
              <tr><td><strong>🏅 会员服务</strong></td><td>${(getProductData('stats', {}).memberCount || 0).toLocaleString()}</td><td>${getProductData('stats', {}).memberRate || '0%'}</td><td><span style="color: var(--color-success);">↑ 2.8%</span></td><td>-</td></tr>
              <tr><td><strong>🎁 激励空投</strong></td><td>${(getProductData('stats', {}).airdropClaimed || 0).toLocaleString()}</td><td>-</td><td><span style="color: var(--color-success);">↑ 12.3%</span></td><td>-</td></tr>
              <tr><td><strong>📱 硬件商城</strong></td><td>${(getProductData('stats', {}).shopOrders || 0).toLocaleString()}</td><td>-</td><td><span style="color: var(--color-success);">↑ 8.7%</span></td><td>${getProductData('stats', {}).shopRevenue || '¥0'}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

// ===== 弹窗系统 =====

function showModal(type, id) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modalOverlay';
  let content = '';

  switch (type) {
    case 'registerService':
    case 'editService':
      const svc = type === 'editService' ? state.services.find(s => s.key === id) : null;
      const isEdit = type === 'editService';
      const chainModeVal = svc?.chainMode || 'optional';
      const triggerModeVal = svc?.triggerMode || 'active';
      content = `
        <div class="modal" style="width: 720px;">
          <div class="modal-header">
            <span class="modal-title">${isEdit ? '编辑服务 - ' + svc?.name : '注册新服务'}</span>
            <span class="modal-close" onclick="closeModal()">✕</span>
          </div>
          <div class="modal-body">
            <div style="border-bottom: 1px solid var(--border-light); padding-bottom: 16px; margin-bottom: 20px;">
              <div style="font-size: 13px; font-weight: 600; color: var(--text-tertiary); margin-bottom: 12px;">基本信息</div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                <div class="form-group"><label class="form-label">服务名称</label><input type="text" class="form-input" value="${svc?.name || ''}" placeholder="如：会员服务"></div>
                <div class="form-group"><label class="form-label">服务Key</label><input type="text" class="form-input" value="${svc?.key || ''}" placeholder="如：member" ${isEdit ? 'readonly style="background:var(--bg-secondary);"' : ''}></div>
              </div>
              <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 16px;">
                <div class="form-group"><label class="form-label">服务描述</label><input type="text" class="form-input" value="${svc?.desc || ''}" placeholder="简要描述服务功能"></div>
                <div class="form-group"><label class="form-label">图标</label><input type="text" class="form-input" value="${svc?.icon || ''}" placeholder="emoji 或图标URL"></div>
              </div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                <div class="form-group"><label class="form-label">默认入口URL</label><input type="text" class="form-input" value="${svc?.callbackUrl || ''}" placeholder="如：/member"></div>
                <div class="form-group"><label class="form-label">数据作用域</label><select class="form-input"><option value="product" ${svc?.dataScope === 'product' ? 'selected' : ''}>按产品隔离</option><option value="global" ${svc?.dataScope === 'global' ? 'selected' : ''}>全局共享</option></select></div>
              </div>
            </div>
            <div style="border-bottom: 1px solid var(--border-light); padding-bottom: 16px; margin-bottom: 20px;">
              <div style="font-size: 13px; font-weight: 600; color: var(--text-tertiary); margin-bottom: 12px;">链与合约绑定</div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                <div class="form-group">
                  <label class="form-label">链绑定模式</label>
                  <select class="form-input" id="chainModeSelect">
                    <option value="none" ${chainModeVal === 'none' ? 'selected' : ''}>不需要链</option>
                    <option value="optional" ${chainModeVal === 'optional' ? 'selected' : ''}>可选（产品自行选择）</option>
                    <option value="required" ${chainModeVal === 'required' ? 'selected' : ''}>必须绑定</option>
                  </select>
                  <div style="font-size: 11px; color: var(--text-tertiary); margin-top: 4px;">可选=产品启用时可单选/多选链；必须=启用时必须绑定至少一条链</div>
                </div>
                <div class="form-group">
                  <label class="form-label">支持的链（多选）</label>
                  <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px;">
                    ${state.chains.map(ch => {
                      const checked = svc?.chains?.includes(ch.id);
                      return `<label style="display: flex; align-items: center; gap: 6px; padding: 5px 10px; border: 1px solid ${checked ? 'var(--brand-primary)' : 'var(--border)'}; border-radius: var(--radius-sm); cursor: pointer; font-size: 12px; background: ${checked ? 'var(--brand-light)' : 'var(--bg-primary)'};"><input type="checkbox" ${checked ? 'checked' : ''} style="accent-color: var(--brand-primary);"> ${ch.name}</label>`;
                    }).join('')}
                  </div>
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">需要的合约类型（多选）</label>
                <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px;">
                  ${['token', 'airdrop', 'membership', 'nft', 'staking'].map(ct => {
                    const checked = svc?.contractTypes?.includes(ct);
                    return `<label style="display: flex; align-items: center; gap: 6px; padding: 5px 10px; border: 1px solid ${checked ? 'var(--brand-primary)' : 'var(--border)'}; border-radius: var(--radius-sm); cursor: pointer; font-size: 12px; background: ${checked ? 'var(--brand-light)' : 'var(--bg-primary)'};"><input type="checkbox" ${checked ? 'checked' : ''} style="accent-color: var(--brand-primary);"> ${ct}</label>`;
                  }).join('')}
                </div>
                <div style="font-size: 11px; color: var(--text-tertiary); margin-top: 4px;">产品启用此服务时，需为选中的合约类型配置对应合约地址</div>
              </div>
            </div>
            <div style="border-bottom: 1px solid var(--border-light); padding-bottom: 16px; margin-bottom: 20px;">
              <div style="font-size: 13px; font-weight: 600; color: var(--text-tertiary); margin-bottom: 12px;">触发模式与定时任务</div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                <div class="form-group">
                  <label class="form-label">触发模式</label>
                  <select class="form-input">
                    <option value="active" ${triggerModeVal === 'active' ? 'selected' : ''}>主动触发（用户操作）</option>
                    <option value="passive" ${triggerModeVal === 'passive' ? 'selected' : ''}>被动触发（系统定时）</option>
                    <option value="both" ${triggerModeVal === 'both' ? 'selected' : ''}>混合模式</option>
                  </select>
                  <div style="font-size: 11px; color: var(--text-tertiary); margin-top: 4px;">主动=用户点击/操作触发；被动=系统定时自动执行；混合=两者皆有</div>
                </div>
                <div class="form-group"><label class="form-label">接口限流</label><input type="text" class="form-input" value="${svc?.rateLimit || '100/min'}" placeholder="如：100/min"></div>
              </div>
              <div class="form-group">
                <label class="form-label">定时任务定义</label>
                <div id="cronJobList" style="display: flex; flex-direction: column; gap: 10px;">
                  ${(svc?.cronJobs || []).map(job => `
                    <div class="cron-job-row" style="display: grid; grid-template-columns: 1fr 140px 100px auto; gap: 8px; align-items: center; padding: 8px 12px; background: var(--bg-secondary); border-radius: var(--radius-sm);">
                      <input type="text" class="form-input" value="${job.name}" placeholder="任务名称" style="font-size: 12px;">
                      <input type="text" class="form-input" value="${job.schedule}" placeholder="cron表达式" style="font-family: monospace; font-size: 11px;">
                      <select class="form-input" style="font-size: 12px;"><option value="passive" ${job.type === 'passive' ? 'selected' : ''}>被动触发</option><option value="active" ${job.type === 'active' ? 'selected' : ''}>主动触发</option></select>
                      <button class="btn btn-secondary btn-sm" onclick="this.closest('.cron-job-row').remove();" style="color: var(--color-danger);">删除</button>
                    </div>
                  `).join('')}
                </div>
                <button class="btn btn-ghost btn-sm" style="margin-top: 8px;" onclick="addCronJobRow()">+ 添加定时任务</button>
              </div>
            </div>
            <div style="border-bottom: 1px solid var(--border-light); padding-bottom: 16px; margin-bottom: 20px;">
              <div style="font-size: 13px; font-weight: 600; color: var(--text-tertiary); margin-bottom: 12px;">前置条件与依赖</div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                <div class="form-group"><label class="form-label">需要登录</label><label class="switch" style="margin-top: 4px;"><input type="checkbox" ${svc?.requireLogin !== false ? 'checked' : ''}><span class="switch-slider"></span></label></div>
                <div class="form-group"><label class="form-label">需要绑定钱包</label><label class="switch" style="margin-top: 4px;"><input type="checkbox" ${svc?.requireWallet ? 'checked' : ''}><span class="switch-slider"></span></label></div>
              </div>
              <div class="form-group">
                <label class="form-label">依赖其他服务（多选）</label>
                <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px;">
                  ${state.services.filter(s => s.key !== svc?.key).map(s => {
                    const checked = svc?.dependencies?.includes(s.key);
                    return `<label style="display: flex; align-items: center; gap: 6px; padding: 5px 10px; border: 1px solid ${checked ? 'var(--brand-primary)' : 'var(--border)'}; border-radius: var(--radius-sm); cursor: pointer; font-size: 12px; background: ${checked ? 'var(--brand-light)' : 'var(--bg-primary)'};"><input type="checkbox" ${checked ? 'checked' : ''} style="accent-color: var(--brand-primary);"> ${s.icon} ${s.name}</label>`;
                  }).join('')}
                </div>
                <div style="font-size: 11px; color: var(--text-tertiary); margin-top: 4px;">启用此服务前，需先启用所选依赖服务</div>
              </div>
            </div>
            <div>
              <div style="font-size: 13px; font-weight: 600; color: var(--text-tertiary); margin-bottom: 12px;">回调与通知</div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                <div class="form-group"><label class="form-label">事件回调URL</label><input type="text" class="form-input" value="${svc?.callbackUrl || ''}" placeholder="如：/api/callback/xxx"></div>
                <div class="form-group">
                  <label class="form-label">通知方式</label>
                  <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px;">
                    <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer;"><input type="checkbox" checked style="accent-color: var(--brand-primary);"> 内部事件</label>
                    <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer;"><input type="checkbox" style="accent-color: var(--brand-primary);"> Webhook</label>
                    <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer;"><input type="checkbox" style="accent-color: var(--brand-primary);"> 邮件通知</label>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="closeModal()">取消</button>
            <button class="btn btn-primary" onclick="alert('${isEdit ? '保存' : '注册'}成功'); closeModal();">${isEdit ? '保存' : '注册'}</button>
          </div>
        </div>
      `;
      break;

    case 'serviceDetail':
      const sd = state.services.find(s => s.key === id);
      const sdUsedBy = state.products.filter(p => p.services.includes(sd?.key));
      const sdChainNames = (sd?.chains || []).map(cid => state.chains.find(c => c.id === cid)?.name).filter(Boolean);
      const sdDepNames = (sd?.dependencies || []).map(dk => state.services.find(sv => sv.key === dk)?.name).filter(Boolean);
      const chainModeLabels = { none: '不需要链', optional: '可选绑定', required: '必须绑定' };
      const triggerModeLabels = { active: '主动触发（用户操作）', passive: '被动触发（系统定时）', both: '混合模式' };
      content = `
        <div class="modal" style="width: 640px;">
          <div class="modal-header">
            <span class="modal-title">${sd?.icon} ${sd?.name} - 服务详情</span>
            <span class="modal-close" onclick="closeModal()">✕</span>
          </div>
          <div class="modal-body">
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px;">
              <div style="padding: 14px; background: var(--bg-secondary); border-radius: var(--radius-sm);">
                <div style="font-size: 11px; color: var(--text-tertiary);">链绑定模式</div>
                <div style="font-size: 14px; font-weight: 600; margin-top: 4px;">${chainModeLabels[sd?.chainMode] || '-'}</div>
              </div>
              <div style="padding: 14px; background: var(--bg-secondary); border-radius: var(--radius-sm);">
                <div style="font-size: 11px; color: var(--text-tertiary);">触发模式</div>
                <div style="font-size: 14px; font-weight: 600; margin-top: 4px;">${triggerModeLabels[sd?.triggerMode] || '-'}</div>
              </div>
              <div style="padding: 14px; background: var(--bg-secondary); border-radius: var(--radius-sm);">
                <div style="font-size: 11px; color: var(--text-tertiary);">数据作用域</div>
                <div style="font-size: 14px; font-weight: 600; margin-top: 4px;">${sd?.dataScope === 'global' ? '全局共享' : '按产品隔离'}</div>
              </div>
            </div>
            <div style="display: flex; flex-direction: column; gap: 14px; font-size: 13px;">
              <div style="display: flex; gap: 8px;"><span style="color: var(--text-tertiary); width: 90px; flex-shrink: 0;">服务Key</span><code style="background: var(--bg-secondary); padding: 2px 8px; border-radius: 4px; font-size: 12px;">${sd?.key}</code></div>
              <div style="display: flex; gap: 8px;"><span style="color: var(--text-tertiary); width: 90px; flex-shrink: 0;">描述</span><span>${sd?.desc}</span></div>
              <div style="display: flex; gap: 8px;"><span style="color: var(--text-tertiary); width: 90px; flex-shrink: 0;">支持的链</span><div style="display: flex; gap: 6px; flex-wrap: wrap;">${sdChainNames.length > 0 ? sdChainNames.map(n => `<span class="tag tag-warning" style="font-size: 11px;">${n}</span>`).join('') : '<span style="color: var(--text-tertiary);">无</span>'}</div></div>
              <div style="display: flex; gap: 8px;"><span style="color: var(--text-tertiary); width: 90px; flex-shrink: 0;">合约类型</span><div style="display: flex; gap: 6px; flex-wrap: wrap;">${(sd?.contractTypes || []).length > 0 ? sd.contractTypes.map(ct => `<span class="tag tag-info" style="font-size: 11px;">${ct}</span>`).join('') : '<span style="color: var(--text-tertiary);">无</span>'}</div></div>
              <div style="display: flex; gap: 8px;"><span style="color: var(--text-tertiary); width: 90px; flex-shrink: 0;">前置条件</span><div style="display: flex; gap: 6px; flex-wrap: wrap;">${sd?.requireLogin ? '<span class="tag tag-success" style="font-size: 11px;">需登录</span>' : ''}${sd?.requireWallet ? '<span class="tag tag-warning" style="font-size: 11px;">需绑定钱包</span>' : ''}${!sd?.requireLogin && !sd?.requireWallet ? '<span style="color: var(--text-tertiary);">无</span>' : ''}</div></div>
              <div style="display: flex; gap: 8px;"><span style="color: var(--text-tertiary); width: 90px; flex-shrink: 0;">依赖服务</span><div style="display: flex; gap: 6px; flex-wrap: wrap;">${sdDepNames.length > 0 ? sdDepNames.map(n => `<span class="tag" style="font-size: 11px; background: var(--bg-secondary);">${n}</span>`).join('') : '<span style="color: var(--text-tertiary);">无</span>'}</div></div>
              <div style="display: flex; gap: 8px;"><span style="color: var(--text-tertiary); width: 90px; flex-shrink: 0;">接口限流</span><span>${sd?.rateLimit || '-'}</span></div>
              <div style="display: flex; gap: 8px;"><span style="color: var(--text-tertiary); width: 90px; flex-shrink: 0;">回调URL</span><code style="font-size: 12px;">${sd?.callbackUrl || '-'}</code></div>
            </div>
            ${(sd?.cronJobs || []).length > 0 ? `
              <div style="margin-top: 20px; border-top: 1px solid var(--border-light); padding-top: 16px;">
                <div style="font-size: 13px; font-weight: 600; margin-bottom: 10px;">定时任务</div>
                <table class="data-table">
                  <thead><tr><th>任务名</th><th>Cron表达式</th><th>触发类型</th><th>说明</th></tr></thead>
                  <tbody>
                    ${sd.cronJobs.map(j => `
                      <tr>
                        <td><strong>${j.name}</strong></td>
                        <td><code style="font-size: 11px;">${j.schedule || '-'}</code></td>
                        <td>${j.type === 'passive' ? '<span class="tag tag-info" style="font-size: 10px;">被动触发</span>' : '<span class="tag tag-success" style="font-size: 10px;">主动触发</span>'}</td>
                        <td style="font-size: 12px; color: var(--text-secondary);">${j.desc}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            ` : ''}
            <div style="margin-top: 20px; border-top: 1px solid var(--border-light); padding-top: 16px;">
              <div style="font-size: 13px; font-weight: 600; margin-bottom: 10px;">已启用产品</div>
              <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                ${sdUsedBy.length > 0 ? sdUsedBy.map(p => `<span class="tag tag-info">${p.icon} ${p.name}</span>`).join('') : '<span style="color: var(--text-tertiary); font-size: 13px;">暂无产品启用</span>'}
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="closeModal()">关闭</button>
            <button class="btn btn-primary" onclick="closeModal(); showModal('editService', '${id}');">编辑</button>
          </div>
        </div>
      `;
      break;

    case 'createAccount':
    case 'editAccount': {
      const isEditAcc = type === 'editAccount';
      const acc = isEditAcc ? state.adminAccounts.find(a => a.id === id) : null;
      content = `
        <div class="modal" style="width: 560px;">
          <div class="modal-header">
            <span class="modal-title">${isEditAcc ? '编辑账号 - ' + acc?.displayName : '创建新账号'}</span>
            <span class="modal-close" onclick="closeModal()">✕</span>
          </div>
          <div class="modal-body">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
              <div class="form-group"><label class="form-label">登录账号 <span style="color: var(--color-danger);">*</span></label><input type="text" class="form-input" value="${acc?.username || ''}" placeholder="如：operator_d" ${isEditAcc ? 'readonly style="background:var(--bg-secondary);"' : ''}></div>
              <div class="form-group"><label class="form-label">显示名称 <span style="color: var(--color-danger);">*</span></label><input type="text" class="form-input" value="${acc?.displayName || ''}" placeholder="如：运营D"></div>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
              <div class="form-group">
                <label class="form-label">角色 <span style="color: var(--color-danger);">*</span></label>
                <select class="form-input" id="accountRoleSelect">
                  <option value="operator" ${acc?.role === 'operator' ? 'selected' : ''}>产品运营</option>
                  <option value="admin" ${acc?.role === 'admin' ? 'selected' : ''}>超级管理员</option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">初始密码 ${isEditAcc ? '' : '<span style="color: var(--color-danger);">*</span>'}</label>
                <input type="text" class="form-input" value="" placeholder="${isEditAcc ? '留空表示不修改' : '请输入初始密码'}">
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">产品权限（多选）<span style="color: var(--color-danger);">*</span></label>
              <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px;">
                ${state.products.map(p => {
                  const checked = acc?.products?.includes(p.id);
                  return `<label style="display: flex; align-items: center; gap: 6px; padding: 6px 12px; border: 1px solid ${checked ? 'var(--brand-primary)' : 'var(--border)'}; border-radius: var(--radius-sm); cursor: pointer; font-size: 13px; background: ${checked ? 'var(--brand-light)' : 'var(--bg-primary)'};"><input type="checkbox" ${checked ? 'checked' : ''} style="accent-color: var(--brand-primary);"> <span style="width: 7px; height: 7px; border-radius: 50%; background: ${p.color};"></span> ${p.name}</label>`;
                }).join('')}
              </div>
              <div style="font-size: 11px; color: var(--text-tertiary); margin-top: 6px;">选中后该账号可切换并管理对应产品的运营数据与配置</div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="closeModal()">取消</button>
            <button class="btn btn-primary" onclick="alert('${isEditAcc ? '保存' : '创建'}成功'); closeModal();">${isEditAcc ? '保存' : '创建'}</button>
          </div>
        </div>
      `;
      break;
    }

    case 'resetPassword': {
      const accReset = state.adminAccounts.find(a => a.id === id);
      content = `
        <div class="modal" style="width: 400px;">
          <div class="modal-header">
            <span class="modal-title">重置密码 - ${accReset?.displayName}</span>
            <span class="modal-close" onclick="closeModal()">✕</span>
          </div>
          <div class="modal-body">
            <div class="form-group"><label class="form-label">新密码 <span style="color: var(--color-danger);">*</span></label><input type="password" class="form-input" placeholder="请输入新密码"></div>
            <div class="form-group"><label class="form-label">确认密码 <span style="color: var(--color-danger);">*</span></label><input type="password" class="form-input" placeholder="请再次输入新密码"></div>
            <div style="font-size: 12px; color: var(--text-tertiary); margin-top: 8px;">重置后该账号需使用新密码登录</div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="closeModal()">取消</button>
            <button class="btn btn-primary" onclick="alert('密码重置成功'); closeModal();">确认重置</button>
          </div>
        </div>
      `;
      break;
    }

    case 'disableAccount':
    case 'enableAccount': {
      const accToggle = state.adminAccounts.find(a => a.id === id);
      const isDisable = type === 'disableAccount';
      content = `
        <div class="modal" style="width: 400px;">
          <div class="modal-header">
            <span class="modal-title">${isDisable ? '停用账号' : '启用账号'}</span>
            <span class="modal-close" onclick="closeModal()">✕</span>
          </div>
          <div class="modal-body">
            <p style="font-size: 14px; color: var(--text-secondary);">
              确定要${isDisable ? '停用' : '启用'}账号 <strong>${accToggle?.displayName}</strong>（${accToggle?.username}）吗？
            </p>
            ${isDisable ? '<p style="font-size: 12px; color: var(--color-danger); margin-top: 8px;">停用后该账号将无法登录后台</p>' : '<p style="font-size: 12px; color: var(--color-success); margin-top: 8px;">启用后该账号可正常登录后台</p>'}
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="closeModal()">取消</button>
            <button class="btn ${isDisable ? 'btn-danger' : 'btn-primary'}" onclick="alert('账号已${isDisable ? '停用' : '启用'}'); closeModal();">确认${isDisable ? '停用' : '启用'}</button>
          </div>
        </div>
      `;
      break;
    }

    default:
      content = `
        <div class="modal" style="width: 400px;">
          <div class="modal-header">
            <span class="modal-title">提示</span>
            <span class="modal-close" onclick="closeModal()">✕</span>
          </div>
          <div class="modal-body"><p>功能开发中...</p></div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="closeModal()">关闭</button>
          </div>
        </div>
      `;
  }

  overlay.innerHTML = content;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
}

function closeModal() {
  const m = document.getElementById('modalOverlay');
  if (m) m.remove();
}

function addCronJobRow() {
  const list = document.getElementById('cronJobList');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'cron-job-row';
  row.style.cssText = 'display: grid; grid-template-columns: 1fr 140px 100px auto; gap: 8px; align-items: center; padding: 8px 12px; background: var(--bg-secondary); border-radius: var(--radius-sm);';
  row.innerHTML = `
    <input type="text" class="form-input" placeholder="任务名称" style="font-size: 12px;">
    <input type="text" class="form-input" placeholder="cron表达式" style="font-family: monospace; font-size: 11px;">
    <select class="form-input" style="font-size: 12px;"><option value="passive">被动触发</option><option value="active">主动触发</option></select>
    <button class="btn btn-secondary btn-sm" onclick="this.closest('.cron-job-row').remove();" style="color: var(--color-danger);">删除</button>
  `;
  list.appendChild(row);
}

document.addEventListener('DOMContentLoaded', render);
