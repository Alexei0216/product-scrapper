const fs = require("fs");

function addPriceMarkup(price, markup) {
  // Remove all commas (thousands separators) and parse the decimal
  const value = Number(String(price || "").replace(/,/g, ""));

  if (!Number.isFinite(value)) return price || "";

  return (value + markup).toFixed(2);
}

function toCSV(products) {
  const header = [
    "Type",
    "Published",
    "In stock?",
    "Visibility in catalog",
    "Name",
    "Regular price",
    "SKU",
    "Performance intercooler kits",
    "Description",
    "Images",
    "FMIC performance",           // Таксономия марка
    "VAG"         // Таксономия марка машины
  ];

  const rows = products.map(p => [
    "simple",
    "1",
    "1",
    "visible",
    p.name,
    addPriceMarkup(p.price, 25),
    p.sku,
    p.category || "",
    p.description,
    Array.isArray(p.images) ? p.images.join(", ") : "",
    p.brand || "",
    p.carBrand || ""
  ]);

  const csv = [header, ...rows]
    .map(row =>
      row
        .map(v => `"${(v || "").replace(/"/g, '""')}"`)
        .join(",")
    )
    .join("\n");

  fs.writeFileSync("products.csv", csv);

  console.log("✔ CSV saved: products.csv");
}

module.exports = toCSV;
