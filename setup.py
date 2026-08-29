from setuptools import find_packages, setup

setup(
    name="mlbricks-builder",
    version="0.7.34",
    description="Hierarchical visual node builder for MLBricks models in Jupyter, Kaggle and Colab.",
    long_description=open("README.md", encoding="utf-8").read(),
    long_description_content_type="text/markdown",
    python_requires=">=3.10",
    packages=find_packages("src"),
    package_dir={"": "src"},
    include_package_data=True,
    package_data={"mlbricks_builder": ["static/*.js", "static/*.css", "*.json"]},
    install_requires=[
        "ipython>=8",
        "ipywidgets>=8",
        "huggingface_hub>=0.24",
        "mlbricks @ git+https://github.com/MlBricks/MLBricks.git",
    ],
)
