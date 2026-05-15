module.exports = {
  listPages: [
    "https://fmic.eu/intake-system/intercoolers/performance-intercooler-kits?car_brand=Volkswagen&product_brand=FMIC+Pro&product_list_limit=49"
  ],

  pages: [],

  // Данные, которые будут применены ко ВСЕМ импортированным товарам
  defaults: {
    category: "Intercoolers",           // Категория товара
    brand: "FMIC Pro",                  // Таксономия: марка
    carBrand: "Volkswagen",             // Таксономия: марка машины
  },

  selectors: {
    productLinks: "a.product-item-link",
    
    title: "h1",
    price: ".price",
    sku: ".sku",
    description: ".prose, .description, .product-description",
    images: ".embla__container img",
  },
};
